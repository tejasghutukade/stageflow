import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { STAGE_WORKER_EXIT } from "../src/runtime/stageWorkerProtocol.js";

const FIXTURE = path.resolve("tests/fixtures/pipelines/browser-human-login.pipeline.yaml");
const savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-hlr-"));
  for (const key of ["STAGEFLOW_HOME", "STAGEFLOW_TOOLCHAIN_MANIFEST"]) savedEnv[key] = process.env[key];
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

async function waitFor(cond: () => boolean | Promise<boolean>) {
  const t = Date.now();
  while (Date.now() - t < 8000) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
}

describe("human login stage resume (process mode)", () => {
  it("does not re-open the login page or run the login check when resuming after the gate", async () => {
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const calls: Array<{ args: string[]; headed: boolean }> = [];
    const runner: BrowserRunner = async (args, env) => {
      calls.push({ args, headed: env.AGENT_BROWSER_HEADED === "1" });
      if (args[0] === "get" && args[1] === "cdp-url") return { code: 0, stdout: "ws://127.0.0.1:41000/devtools/browser/anchor\n" };
      if (args[0] === "get" && args[1] === "url") {
        return { code: 0, stdout: "https://app.example.test/login\n" };
      }
      return { code: 0 };
    };
    const forkFn = ((_entry: string, args: readonly string[]) => {
      const arg = (name: string) => args[args.indexOf(name) + 1];
      const runId = arg("--run-id")!;
      const stageId = arg("--stage-id")!;
      const attempt = Number(arg("--attempt") ?? "1");
      const mode = arg("--mode");
      const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; pid: undefined };
      child.stdout = null;
      child.stderr = null;
      child.pid = undefined;
      setImmediate(async () => {
        await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
        if (stageId === "login" && mode !== "resume") {
          await store.appendStageEvent(runId, stageId, { event: "waiting_for_input" }, { attempt });
          child.emit("exit", STAGE_WORKER_EXIT.WAITING, null);
          return;
        }
        const payload = stageId === "check" ? { logged_in: false, url: "https://app.example.test/login" } : {};
        await store.writeEnvelope(
          runId,
          stageId,
          { status: "success", summary: "ok", artifacts: [], payload },
          { attempt },
        );
        await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt });
        child.emit("exit", 0, null);
      });
      return child;
    }) as never;
    const support: StageBrowserSupport = {
      host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
      profiles: createLocalProfileStore(),
      runner,
      locks: createInMemoryProfileLock(),
      closeWaitMs: 100,
      socketRoot: path.join(root, "sock"),
      loginCheck: { settleMs: 0 },
      display: () => ({ hasDisplay: true, docker: false }),
    };
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      browser: support,
      executionMode: "process",
      stageProcessLauncher: new StageProcessLauncher({ forkFn, cliEntry: "unused" }),
    });
    const started = await manager.startRun({
      task: path.resolve("tests/fixtures/tasks/sample.task.yaml"),
      pipeline: FIXTURE,
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    await waitFor(
      async () =>
        (await store.readRun(started.runId)).stages.find((s) => s.stage_id === "login")?.status ===
        "waiting_for_input",
    );
    const headedOpens = () => calls.filter((c) => c.headed && c.args[0] === "open" && c.args[1] !== "about:blank").map((c) => c.args[1]);
    expect(headedOpens()).toEqual(["https://app.example.test/login"]);

    const answered = await manager.deliverAnswer(started.runId, "login", {
      promptId: "gate-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(answered.ok).toBe(true);
    expect(headedOpens()).toEqual(["https://app.example.test/login"]);
  });
});
