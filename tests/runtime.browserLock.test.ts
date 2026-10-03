import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileLock } from "../src/browser/localProfileLock.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import type { ProfileLock } from "../src/browser/profileLock.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { STAGE_WORKER_EXIT } from "../src/runtime/stageWorkerProtocol.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

type Behavior = "succeed" | "fail" | "wait" | "hang";
type Span = { runId: string; stageId: string; start: number; end?: number };
type Call = { args: string[]; env: Record<string, string> };

let root: string;
let socketRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-lock-"));
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
const withProfile = (id: string, profile: string) =>
  stage(id, { browser: { profile } });
const pipeline = (stages: unknown[]) =>
  ({ id: "lock", stages }) as unknown as InlinePipelineDefinition;

const HOLD_MS = 120;

function launcherFor(
  store: ReturnType<typeof createRunStore>,
  spans: Span[],
  behaviors: Record<string, Behavior> = {},
  children: EventEmitter[] = [],
) {
  const forkFn = ((_entry: string, args: readonly string[]) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const runId = arg("--run-id")!;
    const stageId = arg("--stage-id")!;
    const attempt = Number(arg("--attempt") ?? "1");
    const behavior = behaviors[stageId] ?? "succeed";
    const span: Span = { runId, stageId, start: Date.now() };
    spans.push(span);
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
    children.push(child);
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    setTimeout(async () => {
      await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
      if (behavior === "hang") return;
      if (behavior === "wait") {
        await store.appendStageEvent(runId, stageId, { event: "waiting_for_input" }, { attempt });
        span.end = Date.now();
        child.emit("exit", STAGE_WORKER_EXIT.WAITING, null);
        return;
      }
      if (behavior === "fail") {
        await store.appendStageEvent(runId, stageId, { event: "failed", reason: "boom" }, { attempt });
        span.end = Date.now();
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
      span.end = Date.now();
      child.emit("exit", 0, null);
    }, HOLD_MS);
    return child;
  }) as never;
  return new StageProcessLauncher({ forkFn, cliEntry: "unused" });
}

function setup(locks: ProfileLock, behaviors: Record<string, Behavior> = {}) {
  const store = createRunStore({ rootDir: path.join(root, "store") });
  const spans: Span[] = [];
  const children: EventEmitter[] = [];
  const calls: Call[] = [];
  const launcher = launcherFor(store, spans, behaviors, children);
  const browser: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot }),
    profiles: createLocalProfileStore(),
    runner: async (args, env) => {
      calls.push({ args, env: { ...env } });
      return {
      code: 0,
      stdout: args[1] === "cdp-url" ? "ws://127.0.0.1:41000/devtools/browser/anchor\n" : "",
      };
    },
    closeWaitMs: 200,
    socketRoot,
    locks,
    lockPollMs: 10,
  };
  const startRun = (stages: unknown[], extra: { maxActiveStagesPerRun?: number } = {}) =>
    startPipeline({
      ...extra,
      agent: scriptedFakeAgent([]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: pipeline(stages),
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser,
    });
  return { store, spans, launcher, browser, startRun, children, calls };
}

async function waitFor(cond: () => boolean | Promise<boolean>) {
  const t = Date.now();
  while (Date.now() - t < 8000) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
}

const isAnchor = (c: Call) => c.env.AGENT_BROWSER_PROFILE !== undefined;
const anchorOpens = (calls: Call[]) =>
  calls.flatMap((c, i) => (isAnchor(c) && c.args[0] === "open" ? [i] : []));
const anchorCloses = (calls: Call[]) =>
  calls.flatMap((c, i) => (isAnchor(c) && c.args[0] === "close" ? [i] : []));

const overlap = (a: Span, b: Span) =>
  a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);

const lockImplementations: Array<[string, () => ProfileLock]> = [
  ["local lock file", () => createLocalProfileLock()],
  ["in-memory lock", () => createInMemoryProfileLock()],
];

describe.each(lockImplementations)("browser profile lock in pipelines: %s", (_n, makeLock) => {
  it("runs two parallel stages of one run on one profile at the same time, sharing one anchor", async () => {
    const { spans, startRun, calls } = setup(makeLock());
    const started = await startRun([withProfile("a", "acct"), withProfile("b", "acct")]);
    expect((await started.done).outcome).toBe("succeeded");
    expect(spans).toHaveLength(2);
    expect(overlap(spans[0]!, spans[1]!)).toBe(true);
    expect(anchorOpens(calls)).toHaveLength(1);
    expect(anchorCloses(calls)).toHaveLength(1);
    const sessions = new Set(
      calls.filter((c) => c.env.AGENT_BROWSER_CDP !== undefined).map((c) => c.env.AGENT_BROWSER_SESSION),
    );
    expect(sessions.size).toBe(2);
  });

  it("runs stages with different profiles or no profile together", async () => {
    const { spans, startRun } = setup(makeLock());
    const started = await startRun([
      withProfile("a", "one"),
      withProfile("b", "two"),
      stage("plain"),
      stage("throwaway", { browser: {} }),
    ]);
    expect((await started.done).outcome).toBe("succeeded");
    expect(spans).toHaveLength(4);
    for (const s of spans) {
      for (const o of spans) if (s !== o) expect(overlap(s, o)).toBe(true);
    }
  });

  it("makes a second run wait, names the holder, then proceeds", async () => {
    const { store, spans, startRun, calls } = setup(makeLock());
    const first = await startRun([withProfile("a", "acct")]);
    await waitFor(() => spans.length === 1);
    const second = await startRun([withProfile("b", "acct")]);

    await waitFor(async () => {
      const events = await store.listStageEvents(second.runId, "b");
      return events.some((e) => "text" in e && /waiting for browser profile/.test(String(e.text)));
    });
    const events = await store.listStageEvents(second.runId, "b");
    const waiting = events.find((e) => "text" in e && /waiting for browser profile/.test(String(e.text)));
    expect(String((waiting as { text: string }).text)).toContain(first.runId);
    expect(spans.filter((s) => s.runId === second.runId)).toHaveLength(0);

    expect((await first.done).outcome).toBe("succeeded");
    expect((await second.done).outcome).toBe("succeeded");
    const [s1, s2] = [
      spans.find((s) => s.runId === first.runId)!,
      spans.find((s) => s.runId === second.runId)!,
    ];
    expect(s2.start).toBeGreaterThanOrEqual(s1.end!);
    const opens = anchorOpens(calls);
    const closes = anchorCloses(calls);
    expect(opens).toHaveLength(2);
    expect(closes).toHaveLength(2);
    expect(closes[0]!).toBeLessThan(opens[1]!);
  });

  it("starts the waiting run only after a failed run, with the first anchor closed", async () => {
    const { spans, startRun, calls } = setup(makeLock(), { a: "fail" });
    const first = await startRun([withProfile("a", "acct")]);
    await waitFor(() => spans.length === 1);
    const second = await startRun([withProfile("b", "acct")]);
    expect((await first.done).outcome).toBe("failed");
    expect((await second.done).outcome).toBe("succeeded");
    const opens = anchorOpens(calls);
    expect(opens).toHaveLength(2);
    expect(anchorCloses(calls)[0]!).toBeLessThan(opens[1]!);
  });

  it("does not let a stage queued behind another run hold an active slot of its run", async () => {
    const locks = makeLock();
    const { spans, startRun, store } = setup(locks);
    const first = await startRun([withProfile("a", "acct")]);
    await waitFor(() => spans.length === 1);
    const second = await startRun(
      [withProfile("b", "acct"), stage("c")],
      { maxActiveStagesPerRun: 1 },
    );
    await waitFor(() => spans.some((x) => x.runId === second.runId && x.stageId === "c"));
    const events = await store.listStageEvents(second.runId, "b");
    expect(events.some((e) => "text" in e && /held by run/.test(String(e.text)))).toBe(true);
    expect(spans.filter((x) => x.runId === second.runId && x.stageId === "b")).toHaveLength(0);
    expect((await locks.holder({ scope: "local", name: "acct" }))?.runId).toBe(first.runId);
    expect((await first.done).outcome).toBe("succeeded");
    expect((await second.done).outcome).toBe("succeeded");
  });

  it("releases the profile after a failed stage", async () => {
    const locks = makeLock();
    const { spans, startRun, calls } = setup(locks, { a: "fail" });
    const first = await startRun([withProfile("a", "acct")]);
    await first.done;
    expect(anchorCloses(calls)).toHaveLength(1);
    expect(await locks.holder({ scope: "local", name: "acct" })).toBeUndefined();
    const second = await startRun([withProfile("b", "acct")]);
    expect((await second.done).outcome).toBe("succeeded");
    expect(spans).toHaveLength(2);
  });

  it("keeps the profile while the stage waits at a gate, and frees it on cancel", async () => {
    const locks = makeLock();
    const { store, spans, launcher, browser, startRun, calls } = setup(locks, { a: "wait" });
    const first = await startRun([withProfile("a", "acct")]);
    await first.done;
    expect((await locks.holder({ scope: "local", name: "acct" }))?.runId).toBe(first.runId);
    expect(anchorOpens(calls)).toHaveLength(1);
    expect(anchorCloses(calls)).toHaveLength(0);

    const second = await startRun([withProfile("b", "acct")]);
    await new Promise((r) => setTimeout(r, 4 * HOLD_MS));
    expect(spans.filter((s) => s.runId === second.runId)).toHaveLength(0);

    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser,
    });
    expect((await manager.cancelRun(first.runId, "stop")).ok).toBe(true);
    expect(anchorCloses(calls)).toHaveLength(1);
    expect((await second.done).outcome).toBe("succeeded");
  });

  it("frees the profile when its run is cancelled mid-stage", async () => {
    const locks = makeLock();
    const { store, spans, launcher, browser, startRun, children } = setup(locks, { a: "hang" });
    const first = await startRun([withProfile("a", "acct")]);
    await waitFor(() => spans.length === 1);
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser,
    });
    const before = children[0]!.listenerCount("exit");
    const cancelling = manager.cancelRun(first.runId, "stop");
    await waitFor(() => children[0]!.listenerCount("exit") > before);
    children[0]!.emit("exit", null, "SIGTERM");
    expect((await cancelling).ok).toBe(true);
    await waitFor(
      async () => (await locks.holder({ scope: "local", name: "acct" })) === undefined,
    );
    await first.done.catch(() => undefined);
  });
});

describe("stale locks at Host start", () => {
  it("sweepBrowserSessions reclaims locks of dead runs and keeps live ones", async () => {
    const locks = createLocalProfileLock();
    const { store, browser } = setup(locks);
    const live = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(live.runId, "running");
    const done = await store.createRun({ pipelineId: "p", taskYaml: "id: t\ngoal: g\n" });
    await store.updateRunStatus(done.runId, "failed");
    await locks.acquire({ scope: "local", name: "live" }, { runId: live.runId, stageId: "s" });
    await locks.acquire({ scope: "local", name: "done" }, { runId: done.runId, stageId: "s" });
    await locks.acquire({ scope: "local", name: "gone" }, { runId: "no-such-run", stageId: "s" });

    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      browser,
    });
    await manager.sweepBrowserSessions();

    const fresh = createLocalProfileLock();
    expect(await fresh.holder({ scope: "local", name: "live" })).toBeDefined();
    expect(await fresh.holder({ scope: "local", name: "done" })).toBeUndefined();
    expect(await fresh.holder({ scope: "local", name: "gone" })).toBeUndefined();
  });
});
