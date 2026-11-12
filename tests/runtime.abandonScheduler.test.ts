import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { STAGE_WORKER_EXIT } from "../src/runtime/stageWorkerProtocol.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const ABANDON_REASON = "process_interrupted: operator abandoned stage";

type Behavior = "succeed" | "hang" | "wait";
type FakeChild = EventEmitter & { stdout: null; stderr: null; pid: undefined };

let root: string;
const savedHome = process.env.STAGEFLOW_HOME;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-abandon-sched-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = savedHome;
  resetGlobalStageflowHomeForTests();
  await rm(root, { recursive: true, force: true });
});

/** Fake workers: `behavior(stageId, call)` picks what each spawn does; children are kept per stage, newest last. */
function fakeLauncher(
  store: ReturnType<typeof createRunStore>,
  behavior: (stageId: string, call: number) => Behavior,
) {
  const children = new Map<string, FakeChild[]>();
  const forkFn = ((_entry: string, args: readonly string[]) => {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    const runId = arg("--run-id")!;
    const stageId = arg("--stage-id")!;
    const attempt = Number(arg("--attempt") ?? "1");
    const list = children.get(stageId) ?? [];
    const mode = behavior(stageId, list.length);
    const child = new EventEmitter() as FakeChild;
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    list.push(child);
    children.set(stageId, list);
    setImmediate(async () => {
      await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt });
      if (mode === "hang") return;
      if (mode === "wait") {
        await store.appendStageEvent(runId, stageId, { event: "waiting_for_input" }, { attempt });
        child.emit("exit", STAGE_WORKER_EXIT.WAITING, null);
        return;
      }
      await store.writeEnvelope(runId, stageId, { status: "success", summary: "ok", artifacts: [], payload: {} }, { attempt });
      await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt });
      child.emit("exit", 0, null);
    });
    return child;
  }) as never;
  return { launcher: new StageProcessLauncher({ forkFn, cliEntry: "unused" }), children };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout");
}

/** The fake child has no pid, so the launcher cannot signal it: emit the exit once the launcher waits for it. */
async function killWhenAsked(child: FakeChild, before: number): Promise<void> {
  await waitFor(() => child.listenerCount("exit") > before);
  child.emit("exit", null, "SIGTERM");
}

async function stageStatus(store: ReturnType<typeof createRunStore>, runId: string, stageId: string) {
  return (await store.readRun(runId)).stages.find((stage) => stage.stage_id === stageId)?.status;
}

function spawnCount(children: Map<string, FakeChild[]>): number {
  return [...children.values()].reduce((sum, list) => sum + list.length, 0);
}

describe("abandoning one stage of a scheduler-driven run", () => {
  it("keeps the run's slot while a sibling runs, records the abandon reason, and a later cancel still stops the run", async () => {
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const { launcher, children } = fakeLauncher(store, (stageId) =>
      stageId === "improve-a" || stageId === "improve-b" ? "hang" : "succeed",
    );
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
    });
    const started = await manager.startRun({ task: SAMPLE_TASK, pipeline: pipelinePath("parallel-track-fanout") });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const runId = started.runId;
    await waitFor(async () =>
      (await stageStatus(store, runId, "improve-a")) === "running" &&
      (await stageStatus(store, runId, "improve-b")) === "running",
    );
    expect(manager.getActiveCount()).toBe(1);

    const childA = children.get("improve-a")!.at(-1)!;
    const abandoning = manager.abandonStage(runId, "improve-a");
    await killWhenAsked(childA, childA.listenerCount("exit"));
    expect((await abandoning).ok).toBe(true);

    await waitFor(async () => (await stageStatus(store, runId, "improve-a")) === "failed");
    expect(await stageStatus(store, runId, "improve-b")).toBe("running");
    // The sibling still runs, so the run keeps its slot, lease and scheduling halt.
    expect(manager.getActiveCount()).toBe(1);
    const reasons = (await store.listStageEvents(runId, "improve-a"))
      .filter((event) => event.event === "failed")
      .map((event) => (event as { reason?: string }).reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason === ABANDON_REASON)).toBe(true);
    // An unhandled failed stage makes the run read failed (fail fast), while the sibling is left to finish.

    const spawnedBeforeCancel = spawnCount(children);
    const childB = children.get("improve-b")!.at(-1)!;
    const cancelling = manager.cancelRun(runId, "stop");
    await killWhenAsked(childB, childB.listenerCount("exit"));
    expect((await cancelling).ok).toBe(true);
    await waitFor(() => manager.getActiveCount() === 0);
    expect(await stageStatus(store, runId, "improve-b")).toBe("failed");
    expect((await store.readRunMeta(runId)).status).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing new was launched after the cancel.
    expect(spawnCount(children)).toBe(spawnedBeforeCancel);
  });

  it("does not fail the run when a stage resumed after an answer is abandoned while a sibling runs", async () => {
    const store = createRunStore({ rootDir: path.join(root, "store") });
    const { launcher, children } = fakeLauncher(store, (stageId, call) => {
      if (stageId === "improve-a") return call === 0 ? "wait" : "hang";
      if (stageId === "improve-b") return "hang";
      return "succeed";
    });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      executionMode: "process",
      stageProcessLauncher: launcher,
    });
    const started = await manager.startRun({ task: SAMPLE_TASK, pipeline: pipelinePath("parallel-track-fanout") });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const runId = started.runId;
    await waitFor(async () =>
      (await stageStatus(store, runId, "improve-a")) === "waiting_for_input" &&
      (await stageStatus(store, runId, "improve-b")) === "running",
    );

    // In process mode the answer resolves when the resumed worker ends; this one hangs until abandoned.
    const answering = manager.deliverAnswer(runId, "improve-a", {
      promptId: "gate-1",
      kind: "free_text",
      text: "go on",
    });
    await waitFor(() => (children.get("improve-a")?.length ?? 0) === 2);
    await waitFor(async () => (await stageStatus(store, runId, "improve-a")) === "running");

    const resumed = children.get("improve-a")!.at(-1)!;
    const abandoning = manager.abandonStage(runId, "improve-a");
    await killWhenAsked(resumed, resumed.listenerCount("exit"));
    expect((await abandoning).ok).toBe(true);
    await answering;

    await waitFor(async () => (await stageStatus(store, runId, "improve-a")) === "failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await stageStatus(store, runId, "improve-b")).toBe("running");
    expect(manager.getActiveCount()).toBe(1);

    const childB = children.get("improve-b")!.at(-1)!;
    const cancelling = manager.cancelRun(runId, "stop");
    await killWhenAsked(childB, childB.listenerCount("exit"));
    expect((await cancelling).ok).toBe(true);
    await waitFor(() => manager.getActiveCount() === 0);
  });
});
