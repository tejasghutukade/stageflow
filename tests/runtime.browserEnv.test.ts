import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { createFakeRemoteBrowserHost } from "../src/browser/fakeRemoteBrowserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileStore } from "../src/browser/memoryProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

type Launched = { stageId: string; attempt: number; env: Record<string, string> };

let home: string;
let manifest: string;
const savedEnv: Record<string, string | undefined> = {};
const AMBIENT = {
  AGENT_BROWSER_PROFILE: "/ambient/profile",
  AGENT_BROWSER_SESSION: "ambient-session",
  AGENT_BROWSER_CDP: "ws://ambient",
};

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sf-browser-env-"));
  home = path.join(root, "h".repeat(70), "i".repeat(70), "stageflow-home");
  manifest = path.join(root, "toolchain.json");
  await writeFile(
    manifest,
    JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }),
  );
  for (const key of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST", "STAGEFLOW_STAGE_ENV_ALLOW", ...Object.keys(AMBIENT)]) {
    savedEnv[key] = process.env[key];
  }
  process.env.STAGEFLOW_HOME = home;
  process.env.STAGEFLOW_TOOLCHAIN_MANIFEST = manifest;
  Object.assign(process.env, AMBIENT);
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
  await rm(path.dirname(path.dirname(path.dirname(home))), { recursive: true, force: true });
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
  ({ id: "browser-env", stages }) as unknown as InlinePipelineDefinition;

function fakeWorkerLauncher(
  store: ReturnType<typeof createRunStore>,
  launched: Launched[],
  failFirstAttemptOf?: string,
) {
  const forkFn = ((_entry: string, args: readonly string[], options: { env: Record<string, string> }) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const runId = arg("--run-id")!;
    const stageId = arg("--stage-id")!;
    const attempt = Number(arg("--attempt") ?? "1");
    launched.push({ stageId, attempt, env: { ...options.env } });
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    setImmediate(async () => {
      const fail = stageId === failFirstAttemptOf && attempt === 1;
      await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
      if (fail) {
        await store.appendStageEvent(runId, stageId, { event: "failed", reason: "boom" }, { attempt });
      } else {
        await store.writeEnvelope(
          runId,
          stageId,
          { status: "success", summary: "ok", artifacts: [], payload: {} },
          { attempt },
        );
        await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt });
      }
      child.emit("exit", fail ? 1 : 0, null);
    });
    return child;
  }) as never;
  return new StageProcessLauncher({ forkFn, cliEntry: "unused" });
}

async function waitForStatus(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  status: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if ((await store.readRunMeta(runId)).status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${status}`);
}

const localSupport = (opts: Parameters<typeof createLocalBrowserHost>[0] = {}): StageBrowserSupport => ({
  host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, ...opts }),
  profiles: createLocalProfileStore(),
});

async function run(
  support: StageBrowserSupport,
  stages: unknown[],
  failFirstAttemptOf?: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-browser-run-"));
  const store = createRunStore({ rootDir: root });
  const launched: Launched[] = [];
  const launcher = fakeWorkerLauncher(store, launched, failFirstAttemptOf);
  const started = await startPipeline({
    agent: scriptedFakeAgent([]),
    store,
    taskYaml: "id: t\ngoal: g\n",
    pipeline: pipeline(stages),
    cwd: root,
    executionMode: "process",
    stageProcessLauncher: launcher,
    browser: support,
  });
  return { store, launched, launcher, started, root };
}

const envOf = (launched: Launched[], stageId: string, attempt = 1) =>
  launched.find((l) => l.stageId === stageId && l.attempt === attempt)!.env;

describe("browser env reaches the stage worker environment", () => {
  it("browser stage gets explicit settings; non-browser stage gets none", async () => {
    const { launched, started } = await run(localSupport(), [
      stage("login", { browser: { profile: "acct" } }),
      stage("plain"),
    ]);
    await started.done;

    const login = envOf(launched, "login");
    expect(login.AGENT_BROWSER_PROFILE).toBe(path.join(home, "browser", "local", "acct", "profile"));
    expect(login.AGENT_BROWSER_SESSION).toBe("sf-acct");
    expect(login.AGENT_BROWSER_HEADED).toBe("1");
    expect(login.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("0");
    expect(login.AGENT_BROWSER_CONFIG).toBeTruthy();
    expect(login).not.toHaveProperty("AGENT_BROWSER_CDP");

    const plain = envOf(launched, "plain");
    expect(Object.keys(plain).filter((k) => k.startsWith("AGENT_BROWSER_"))).toEqual([]);
  });

  it("does not take settings from Host ambient env, even when allow-listed", async () => {
    process.env.STAGEFLOW_STAGE_ENV_ALLOW = Object.keys(AMBIENT).join(",");
    const { launched, started } = await run(localSupport(), [
      stage("login", { browser: { profile: "acct" } }),
      stage("plain"),
    ]);
    await started.done;
    const login = envOf(launched, "login");
    expect(login.AGENT_BROWSER_PROFILE).not.toBe("/ambient/profile");
    expect(login.AGENT_BROWSER_SESSION).not.toBe("ambient-session");
    expect(login).not.toHaveProperty("AGENT_BROWSER_CDP");
  });

  it("keeps the socket path under the limit with a deeply nested STAGEFLOW_HOME", async () => {
    expect(home.length).toBeGreaterThan(140);
    const { launched, started } = await run(localSupport(), [
      stage("login", { browser: { profile: "p".repeat(64) } }),
    ]);
    await started.done;
    const env = envOf(launched, "login");
    const sock = path.join(env.AGENT_BROWSER_SOCKET_DIR!, `${env.AGENT_BROWSER_SESSION}.sock`);
    expect(Buffer.byteLength(sock)).toBeLessThan(103);
  });

  it("profile-less stage has no profile var and gets the allowlist", async () => {
    const { launched, started } = await run(localSupport(), [
      stage("scrape", { browser: { allow_domains: ["example.com"] } }),
    ]);
    await started.done;
    const env = envOf(launched, "scrape");
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("example.com");
  });

  it("is headless when the stage asks or no display exists", async () => {
    const asked = await run(localSupport(), [stage("s", { browser: { headed: false } })]);
    await asked.started.done;
    expect(envOf(asked.launched, "s").AGENT_BROWSER_HEADED).toBe("0");

    const noDisplay = await run(localSupport({ platform: "linux", hostEnv: {} }), [
      stage("s", { browser: {} }),
    ]);
    await noDisplay.started.done;
    expect(envOf(noDisplay.launched, "s").AGENT_BROWSER_HEADED).toBe("0");
  });

  it("gives the same env on every attempt of one stage", async () => {
    const { store, launched, launcher, started, root } = await run(
      localSupport(),
      [stage("login", { browser: { profile: "acct" } })],
      "login",
    );
    await started.done;
    await waitForStatus(store, started.runId, "failed");

    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
      browser: localSupport(),
    });
    const retry = await manager.retryStage(started.runId, "login");
    expect(retry.ok).toBe(true);
    await waitForStatus(store, started.runId, "succeeded");

    expect(envOf(launched, "login", 2)).toEqual(
      expect.objectContaining(
        Object.fromEntries(
          Object.entries(envOf(launched, "login", 1)).filter(([k]) =>
            k.startsWith("AGENT_BROWSER_"),
          ),
        ),
      ),
    );
  });

  it("with a remote host the stage gets the remote address and no local profile path", async () => {
    const { launched, started } = await run(
      {
        host: createFakeRemoteBrowserHost("wss://browsers.example/s1"),
        profiles: createInMemoryProfileStore(),
      },
      [stage("login", { browser: { profile: "acct" } })],
    );
    await started.done;
    const env = envOf(launched, "login");
    expect(env.AGENT_BROWSER_CDP).toBe("wss://browsers.example/s1");
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
  });
});
