import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type {
  BrowserRunner,
  StageBrowserSupport,
} from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { STAGE_WORKER_EXIT } from "../src/runtime/stageWorkerProtocol.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

type Call = { args: string[]; env: Record<string, string> };
type Behavior = "succeed" | "fail" | "wait" | "hang";

let root: string;
let socketRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-bt-"));
  socketRoot = path.join(root, "sock");
  for (const key of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) {
    savedEnv[key] = process.env[key];
  }
  const manifest = path.join(root, "toolchain.json");
  await writeFile(
    manifest,
    JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }),
  );
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  process.env.STAGEFLOW_TOOLCHAIN_MANIFEST = manifest;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
  await rm(root, { recursive: true, force: true });
});

const io = { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } };
const stage = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  system_prompt: "x",
  model: "anthropic/claude-sonnet-4-5",
  io,
  ...extra,
});
const pipeline = (stages: unknown[]) =>
  ({ id: "teardown", stages }) as unknown as InlinePipelineDefinition;

/** Fake agent-browser: records calls; `close` makes the daemon (sock/pid) vanish, leaving config/target behind. */
function fakeRunner(calls: Call[]): BrowserRunner {
  return async (args, env) => {
    calls.push({ args, env: { ...env } });
    const dir = env.AGENT_BROWSER_SOCKET_DIR;
    const session = env.AGENT_BROWSER_SESSION;
    if (args[0] === "close" && dir && session) {
      await rm(path.join(dir, `${session}.sock`), { force: true });
    }
    return {
      code: 0,
      stdout: args[0] === "get" && args[1] === "cdp-url" ? "ws://127.0.0.1:41000/devtools/browser/anchor\n" : "",
    };
  };
}

function support(calls: Call[], extra: Partial<StageBrowserSupport> = {}): StageBrowserSupport {
  return {
    ...extra,
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot }),
    profiles: createLocalProfileStore(),
    runner: fakeRunner(calls),
    closeWaitMs: 500,
    socketRoot,
  };
}

async function plantDaemonFiles(env: Record<string, string>) {
  const dir = env.AGENT_BROWSER_SOCKET_DIR;
  const session = env.AGENT_BROWSER_SESSION;
  if (!dir || !session) return;
  await mkdir(dir, { recursive: true });
  for (const ext of ["sock", "config", "target"]) {
    await writeFile(path.join(dir, `${session}.${ext}`), "x");
  }
}

function launcherFor(
  store: ReturnType<typeof createRunStore>,
  behaviors: Record<string, Behavior>,
  children: EventEmitter[] = [],
) {
  const forkFn = ((_entry: string, args: readonly string[], options: { env: Record<string, string> }) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const runId = arg("--run-id")!;
    const stageId = arg("--stage-id")!;
    const attempt = Number(arg("--attempt") ?? "1");
    const behavior = behaviors[stageId] ?? "succeed";
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    children.push(child);
    setImmediate(async () => {
      await plantDaemonFiles(options.env);
      await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
      if (behavior === "hang") return;
      if (behavior === "wait") {
        await store.appendStageEvent(runId, stageId, { event: "waiting_for_input" }, { attempt });
        child.emit("exit", STAGE_WORKER_EXIT.WAITING, null);
        return;
      }
      if (behavior === "fail") {
        await store.appendStageEvent(runId, stageId, { event: "failed", reason: "stage timed out" }, { attempt });
        child.emit("exit", 1, null);
        return;
      }
      await store.writeEnvelope(
        runId,
        stageId,
        { status: "success", summary: "ok", artifacts: [], payload: {} },
        { attempt },
      );
      await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt });
      child.emit("exit", 0, null);
    });
    return child;
  }) as never;
  return new StageProcessLauncher({ forkFn, cliEntry: "unused" });
}

async function start(
  calls: Call[],
  stages: unknown[],
  behaviors: Record<string, Behavior>,
  children: EventEmitter[] = [],
  extra: Partial<StageBrowserSupport> = {},
) {
  const store = createRunStore({ rootDir: path.join(root, "store") });
  const launcher = launcherFor(store, behaviors, children);
  const browser = support(calls, extra);
  const started = await startPipeline({
    agent: scriptedFakeAgent([]),
    store,
    taskYaml: "id: t\ngoal: g\n",
    pipeline: pipeline(stages),
    cwd: root,
    executionMode: "process",
    stageProcessLauncher: launcher,
    browser,
  });
  return { store, launcher, browser, started };
}

async function waitFor(cond: () => boolean | Promise<boolean>) {
  const t = Date.now();
  while (Date.now() - t < 8000) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

async function persistedEnv(store: ReturnType<typeof createRunStore>, runId: string, stageId: string) {
  const file = path.join(store.getWorkspaceDir(runId), "stages", stageId, "browser-env.json");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
}

const closes = (calls: Call[]) => calls.filter((c) => c.args[0] === "close");
const isAnchorCall = (c: Call) => c.env.AGENT_BROWSER_PROFILE !== undefined;
const stageCloses = (calls: Call[]) => closes(calls).filter((c) => !isAnchorCall(c));
const anchorCloses = (calls: Call[]) => closes(calls).filter(isAnchorCall);
const tabCloses = (calls: Call[]) =>
  calls.filter((c) => c.args[0] === "tab" && c.args[1] === "close");

describe("browser teardown", () => {
  it("closes the stage tab then its session with the persisted env, and the anchor once at run end", async () => {
    const calls: Call[] = [];
    const { store, started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], {});
    await started.done;
    const env = await persistedEnv(store, started.runId, "s");
    expect(tabCloses(calls)).toHaveLength(1);
    expect(tabCloses(calls)[0]!.env).toEqual(env);
    expect(stageCloses(calls)).toHaveLength(1);
    expect(stageCloses(calls)[0]!.env).toEqual(env);
    expect(calls.indexOf(tabCloses(calls)[0]!)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
    expect(anchorCloses(calls)).toHaveLength(1);
    expect(calls.indexOf(stageCloses(calls)[0]!)).toBeLessThan(calls.indexOf(anchorCloses(calls)[0]!));
    expect(existsSync(env.AGENT_BROWSER_SOCKET_DIR!)).toBe(false);
  });

  it("keeps the anchor open between stages of one run and closes it only after the last", async () => {
    const calls: Call[] = [];
    const { started } = await start(
      calls,
      [
        stage("one", { entry: true, route: [{ to: "two" }], browser: { profile: "acct" } }),
        stage("two", { browser: { profile: "acct" } }),
      ],
      {},
    );
    await started.done;
    expect(stageCloses(calls)).toHaveLength(2);
    expect(anchorCloses(calls)).toHaveLength(1);
    const lastStageClose = calls.lastIndexOf(stageCloses(calls)[1]!);
    expect(calls.indexOf(anchorCloses(calls)[0]!)).toBeGreaterThan(lastStageClose);
    const firstStageClose = calls.indexOf(stageCloses(calls)[0]!);
    const anchorOpens = calls.filter((c) => isAnchorCall(c) && c.args[0] === "open");
    expect(anchorOpens).toHaveLength(1);
    expect(calls.indexOf(anchorOpens[0]!)).toBeLessThan(firstStageClose);
  });

  it("makes no tab-close for a stage without a profile, and closes its own session", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: {} })], {});
    await started.done;
    expect(tabCloses(calls)).toEqual([]);
    expect(stageCloses(calls)).toHaveLength(1);
    expect(anchorCloses(calls)).toEqual([]);
  });

  it("closes stage and anchor after a failed or timed-out stage", async () => {
    const calls: Call[] = [];
    const { store, started } = await start(
      calls,
      [stage("s", { browser: { profile: "acct" } })],
      { s: "fail" },
    );
    await started.done;
    const env = await persistedEnv(store, started.runId, "s");
    expect(tabCloses(calls)).toHaveLength(1);
    expect(stageCloses(calls)[0]!.env).toEqual(env);
    expect(anchorCloses(calls)).toHaveLength(1);
    expect(existsSync(path.join(env.AGENT_BROWSER_SOCKET_DIR!, `${env.AGENT_BROWSER_SESSION}.config`))).toBe(false);
  });

  it("keeps the session open while the stage waits for the operator", async () => {
    const calls: Call[] = [];
    const { store, started } = await start(
      calls,
      [stage("s", { browser: { profile: "acct" } })],
      { s: "wait" },
    );
    await started.done;
    const env = await persistedEnv(store, started.runId, "s");
    expect(closes(calls)).toEqual([]);
    expect(tabCloses(calls)).toEqual([]);
    expect(existsSync(path.join(env.AGENT_BROWSER_SOCKET_DIR!, `${env.AGENT_BROWSER_SESSION}.sock`))).toBe(true);
  });

  it("closes on cancel", async () => {
    const calls: Call[] = [];
    const children: EventEmitter[] = [];
    const { store, launcher, browser, started } = await start(
      calls,
      [stage("s", { browser: { profile: "acct" } })],
      { s: "hang" },
      children,
    );
    await waitFor(async () => {
      try {
        await persistedEnv(store, started.runId, "s");
        return children.length > 0;
      } catch {
        return false;
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser,
    });
    const before = children[0]!.listenerCount("exit");
    const cancelling = manager.cancelRun(started.runId, "stop");
    await waitFor(() => children[0]!.listenerCount("exit") > before);
    children[0]!.emit("exit", null, "SIGTERM");
    expect((await cancelling).ok).toBe(true);
    await started.done.catch(() => undefined);
    const env = await persistedEnv(store, started.runId, "s");
    expect(stageCloses(calls)[0]!.env).toEqual(env);
    expect(anchorCloses(calls)).toHaveLength(1);
    expect(existsSync(env.AGENT_BROWSER_SOCKET_DIR!)).toBe(false);
  });

  it("makes no browser calls for a stage without a browser field", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("plain")], {});
    await started.done;
    expect(calls).toEqual([]);
  });

  it("does no browser teardown work at all for a run without browser stages", async () => {
    const calls: Call[] = [];
    const lockCalls: string[] = [];
    const locks = {
      acquire: async () => {
        lockCalls.push("acquire");
        return { status: "acquired" as const, release: async () => undefined };
      },
      holder: async () => {
        lockCalls.push("holder");
        return undefined;
      },
      releaseOwner: async () => {
        lockCalls.push("releaseOwner");
      },
      reclaimStale: async () => {
        lockCalls.push("reclaimStale");
        return 0;
      },
    };
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const started = await startPipeline({
      agent: scriptedFakeAgent([]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: pipeline([stage("plain")]),
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcherFor(store, {}, []),
      browser: { ...support(calls), locks },
    });
    await started.done;
    expect(calls).toEqual([]);
    expect(lockCalls).toEqual([]);
  });
});

const relayCloses = (calls: Call[]) => calls.filter((c) => c.args[0] === "relay-close");
const recordRelayClose = (calls: Call[]) => async (input: { stageId?: string }) => {
  calls.push({ args: ["relay-close", input.stageId ?? "*"], env: {} });
};

describe("live view relay closes before browser teardown", () => {
  it("closes the stage relay before the tab and session, and the run relay before the anchor", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], {}, [], {
      beforeTeardown: recordRelayClose(calls),
    });
    await started.done;
    const [stageRelay, runRelay] = relayCloses(calls);
    expect(stageRelay!.args[1]).toBe("s");
    expect(runRelay!.args[1]).toBe("*");
    expect(calls.indexOf(stageRelay!)).toBeLessThan(calls.indexOf(tabCloses(calls)[0]!));
    expect(calls.indexOf(stageRelay!)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
    expect(calls.indexOf(tabCloses(calls)[0]!)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
    expect(calls.indexOf(runRelay!)).toBeLessThan(calls.indexOf(anchorCloses(calls)[0]!));
    expect(anchorCloses(calls)).toHaveLength(1);
    expect(tabCloses(calls)).toHaveLength(1);
  });

  it("closes the relay before teardown after a failed stage", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], { s: "fail" }, [], {
      beforeTeardown: recordRelayClose(calls),
    });
    await started.done;
    const first = relayCloses(calls)[0]!;
    expect(first.args[1]).toBe("s");
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(tabCloses(calls)[0]!));
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
  });

  it("does not close any relay while the stage waits at its gate", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], { s: "wait" }, [], {
      beforeTeardown: recordRelayClose(calls),
    });
    await started.done;
    expect(calls.filter((c) => c.args[0] === "relay-close")).toEqual([]);
  });

  it("proceeds with teardown after the bound when the relay close hangs", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], {}, [], {
      beforeTeardown: () => new Promise<void>(() => undefined),
      beforeTeardownWaitMs: 30,
    });
    await started.done;
    expect(tabCloses(calls)).toHaveLength(1);
    expect(stageCloses(calls)).toHaveLength(1);
    expect(anchorCloses(calls)).toHaveLength(1);
  });

  it("proceeds with teardown when the relay close throws", async () => {
    const calls: Call[] = [];
    const { started } = await start(calls, [stage("s", { browser: { profile: "acct" } })], {}, [], {
      beforeTeardown: async () => {
        throw new Error("relay broke");
      },
    });
    await started.done;
    expect(stageCloses(calls)).toHaveLength(1);
    expect(anchorCloses(calls)).toHaveLength(1);
  });

  async function hangingStage(calls: Call[]) {
    const children: EventEmitter[] = [];
    const { store, launcher, browser, started } = await start(
      calls,
      [stage("s", { browser: { profile: "acct" } })],
      { s: "hang" },
      children,
    );
    await waitFor(async () => {
      try {
        await persistedEnv(store, started.runId, "s");
        return children.length > 0;
      } catch {
        return false;
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser,
    });
    manager.beforeBrowserTeardown(recordRelayClose(calls));
    return { manager, children, started };
  }

  it("closes the run relay before browser teardown on cancel", async () => {
    const calls: Call[] = [];
    const { manager, children, started } = await hangingStage(calls);
    const before = children[0]!.listenerCount("exit");
    const cancelling = manager.cancelRun(started.runId, "stop");
    await waitFor(() => children[0]!.listenerCount("exit") > before);
    children[0]!.emit("exit", null, "SIGTERM");
    expect((await cancelling).ok).toBe(true);
    await started.done.catch(() => undefined);
    const first = relayCloses(calls)[0]!;
    expect(first.args[1]).toBe("*");
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(tabCloses(calls)[0]!));
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(anchorCloses(calls)[0]!));
  });

  it("closes the stage relay before browser teardown on abandon", async () => {
    const calls: Call[] = [];
    const { manager, children, started } = await hangingStage(calls);
    const before = children[0]!.listenerCount("exit");
    const abandoning = manager.abandonStage(started.runId, "s");
    await waitFor(() => children[0]!.listenerCount("exit") > before);
    children[0]!.emit("exit", null, "SIGTERM");
    expect((await abandoning).ok).toBe(true);
    await started.done.catch(() => undefined);
    const first = relayCloses(calls)[0]!;
    expect(first.args[1]).toBe("s");
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(tabCloses(calls)[0]!));
    expect(calls.indexOf(first)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
    expect(calls.indexOf(tabCloses(calls)[0]!)).toBeLessThan(calls.indexOf(stageCloses(calls)[0]!));
  });
});

describe("orphan sweep at Host start", () => {
  async function plantSession(runId: string, name: string, extra: Record<string, unknown> = {}) {
    const dir = path.join(socketRoot, name);
    const env = {
      AGENT_BROWSER_SESSION: `sf-${name}`,
      AGENT_BROWSER_SOCKET_DIR: dir,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    };
    await plantDaemonFiles(env);
    await writeFile(
      path.join(dir, "owner.json"),
      JSON.stringify({ runId, stageId: "s", runDir: path.join(root, "gone"), env, ...extra }),
    );
    return env;
  }

  it("closes sessions of dead runs, leaves live and waiting ones, cleans files", async () => {
    const calls: Call[] = [];
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const live = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(live.runId, "running");
    const done = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(done.runId, "succeeded");

    const liveEnv = await plantSession(live.runId, "live");
    const doneEnv = await plantSession(done.runId, "done");
    const goneEnv = await plantSession("no-such-run", "gone");

    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      browser: support(calls),
    });
    await manager.sweepBrowserSessions();

    const closed = closes(calls).map((c) => c.env.AGENT_BROWSER_SESSION).sort();
    expect(closed).toEqual([doneEnv.AGENT_BROWSER_SESSION, goneEnv.AGENT_BROWSER_SESSION].sort());
    expect(existsSync(doneEnv.AGENT_BROWSER_SOCKET_DIR)).toBe(false);
    expect(existsSync(goneEnv.AGENT_BROWSER_SOCKET_DIR)).toBe(false);
    expect(await readdir(liveEnv.AGENT_BROWSER_SOCKET_DIR)).toContain(`${liveEnv.AGENT_BROWSER_SESSION}.sock`);
  });

  it("closes anchors and stage sessions of dead runs (stage first) and leaves live runs' anchors", async () => {
    const calls: Call[] = [];
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const live = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(live.runId, "running");
    const done = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(done.runId, "failed");

    const liveAnchor = await plantSession(live.runId, "live-anchor", { anchor: true, profile: "acct" });
    const doneAnchor = await plantSession(done.runId, "done-anchor", { anchor: true, profile: "acct" });
    const doneStage = await plantSession("no-such-run", "done-stage");
    const manager = new RunManager({ agent: scriptedFakeAgent([]), store, cwd: root, browser: support(calls) });
    await manager.sweepBrowserSessions();

    const closed = closes(calls).map((c) => c.env.AGENT_BROWSER_SESSION);
    expect(closed.sort()).toEqual([doneAnchor.AGENT_BROWSER_SESSION, doneStage.AGENT_BROWSER_SESSION].sort());
    expect(closed).not.toContain(liveAnchor.AGENT_BROWSER_SESSION);
    expect(await readdir(liveAnchor.AGENT_BROWSER_SOCKET_DIR)).toContain(`${liveAnchor.AGENT_BROWSER_SESSION}.sock`);
  });

  it("closes a stage session before the anchor of the same dead run", async () => {
    const calls: Call[] = [];
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const anchor = await plantSession("no-such-run", "aaa-anchor", { anchor: true, profile: "acct" });
    const stageEnv = await plantSession("no-such-run", "zzz-stage");
    const manager = new RunManager({ agent: scriptedFakeAgent([]), store, cwd: root, browser: support(calls) });
    await manager.sweepBrowserSessions();
    expect(closes(calls).map((c) => c.env.AGENT_BROWSER_SESSION)).toEqual([
      stageEnv.AGENT_BROWSER_SESSION,
      anchor.AGENT_BROWSER_SESSION,
    ]);
  });

  it("removes the socket root once no sessions remain", async () => {
    const calls: Call[] = [];
    const store = createRunStore({ rootDir: path.join(root, "store") });
    await plantSession("no-such-run", "gone");
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      browser: support(calls),
    });
    await manager.sweepBrowserSessions();
    expect(existsSync(socketRoot)).toBe(false);
  });
});
