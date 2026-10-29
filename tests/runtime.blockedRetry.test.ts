import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageBrowserSupport } from "../src/browser/browserHost.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

let root: string;
let socketRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-blocked-"));
  socketRoot = path.join(root, "sock");
  for (const key of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) savedEnv[key] = process.env[key];
  const manifest = path.join(root, "toolchain.json");
  await writeFile(manifest, JSON.stringify({ tools: { "agent-browser": { path: "/bin/true", version: "0.38.2" } } }));
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
const BLOCKED = "site blocked this browser: verification challenge";

/** A stage worker that fails with `summaries[attempt - 1]` (a failure envelope) or succeeds past the list. */
function launcherFor(store: ReturnType<typeof createRunStore>, attempts: number[], summaries: string[]) {
  const forkFn = ((_entry: string, args: readonly string[]) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const runId = arg("--run-id")!;
    const stageId = arg("--stage-id")!;
    const attempt = Number(arg("--attempt") ?? "1");
    attempts.push(attempt);
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    setTimeout(async () => {
      await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
      const summary = summaries[attempt - 1];
      if (summary !== undefined) {
        await store.writeEnvelope(runId, stageId, { status: "failure", summary, artifacts: [], payload: {} }, { attempt });
        await store.appendStageEvent(runId, stageId, { event: "failed", reason: "status: failure" }, { attempt });
        child.emit("exit", 1, null);
        return;
      }
      await store.writeEnvelope(runId, stageId, { status: "success", summary: "ok", artifacts: [], payload: {} }, { attempt });
      await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt });
      child.emit("exit", 0, null);
    }, 20);
    return child;
  }) as never;
  return new StageProcessLauncher({ forkFn, cliEntry: "unused" });
}

function setup(options: { summaries: string[]; switched: boolean | undefined }) {
  const store = createRunStore({ rootDir: path.join(root, "store") });
  const attempts: number[] = [];
  const noted: Array<{ scope: string; profile: string }> = [];
  const local = createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot });
  const browser: StageBrowserSupport = {
    host: {
      ...local,
      ...(options.switched === undefined
        ? {}
        : {
            async noteSiteBlocked(input: { scope: string; profile: string }) {
              noted.push({ scope: input.scope, profile: input.profile });
              return { switched: options.switched === true };
            },
          }),
    },
    profiles: createLocalProfileStore(),
    runner: async (args) => ({ code: 0, stdout: args[1] === "cdp-url" ? "ws://127.0.0.1:41000/devtools/browser/anchor\n" : "" }),
    closeWaitMs: 200,
    socketRoot,
    locks: createInMemoryProfileLock(),
    lockPollMs: 10,
  };
  const startRun = (stages: unknown[]) =>
    startPipeline({
      agent: scriptedFakeAgent([]),
      store,
      taskYaml: "id: t\ngoal: g\n",
      pipeline: { id: "blocked", stages } as unknown as InlinePipelineDefinition,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcherFor(store, attempts, options.summaries),
      browser,
    });
  return { store, attempts, noted, startRun };
}

const stage = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  system_prompt: "x",
  model: "anthropic/claude-sonnet-4-5",
  io,
  ...extra,
});

describe("a browser stage blocked by a site", () => {
  it("is run once more when the browser host moved its profile to another browser", async () => {
    const { attempts, noted, startRun, store } = setup({ summaries: [BLOCKED], switched: true });
    const started = await startRun([stage("jobs", { browser: { profile: "acct" } })]);
    expect((await started.done).outcome).toBe("succeeded");
    expect(attempts).toEqual([1, 2]);
    expect(noted).toEqual([{ scope: "local", profile: "acct" }]);
    expect((await store.countStageAttempts(started.runId, "jobs"))).toBe(2);
  });

  it("is not retried when the profile was already on that browser, and the run fails", async () => {
    const { attempts, startRun } = setup({ summaries: [BLOCKED, BLOCKED], switched: false });
    const started = await startRun([stage("jobs", { browser: { profile: "acct" } })]);
    expect((await started.done).outcome).toBe("failed");
    expect(attempts).toEqual([1]);
  });

  it("is retried at most once more even if it is blocked again", async () => {
    const { attempts, startRun } = setup({ summaries: [BLOCKED, BLOCKED, BLOCKED], switched: true });
    const started = await startRun([stage("jobs", { browser: { profile: "acct" } })]);
    expect((await started.done).outcome).toBe("failed");
    expect(attempts).toEqual([1, 2]);
  });

  it("is not retried by a host that cannot switch, or for another kind of failure", async () => {
    const plain = setup({ summaries: [BLOCKED], switched: undefined });
    const a = await plain.startRun([stage("jobs", { browser: { profile: "acct" } })]);
    expect((await a.done).outcome).toBe("failed");
    expect(plain.attempts).toEqual([1]);

    const other = setup({ summaries: ["login lost"], switched: true });
    const b = await other.startRun([stage("jobs", { browser: { profile: "acct" } })]);
    expect((await b.done).outcome).toBe("failed");
    expect(other.attempts).toEqual([1]);
    expect(other.noted).toEqual([]);
  });

  it("is not retried without a browser profile", async () => {
    const { attempts, noted, startRun } = setup({ summaries: [BLOCKED], switched: true });
    const started = await startRun([stage("jobs", { browser: {} })]);
    expect((await started.done).outcome).toBe("failed");
    expect(attempts).toEqual([1]);
    expect(noted).toEqual([]);
  });
});
