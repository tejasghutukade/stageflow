import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import {
  RunRetryCoordinator,
  type RetryTrackingPort,
} from "../src/runtime/runRetryCoordinator.js";
import { StageHitlController } from "../src/runtime/stageHitl.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const issue0 = { id: "i-1", title: "First" };
const issue1 = { id: "i-2", title: "Second" };
const issue2 = { id: "i-3", title: "Third" };

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  payload: {},
  ...extra,
});

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function cloneChainAgent(options: {
  behaviorsByStage: Record<
    string,
    Array<
      | { type: "emit"; envelope: StageEnvelope }
      | { type: "throw"; message: string }
      | { type: "fail"; reason: string; envelope?: StageEnvelope }
      | {
          type: "gate";
          gate: Promise<void>;
          envelope?: StageEnvelope;
          fail?: boolean;
          reason?: string;
        }
    >
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  launchOrder: string[];
} {
  const openCounts = new Map<string, number>();
  const launchOrder: string[] = [];
  const stageIndex = new Map<string, number>();

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    launchOrder: string[];
  } = {
    openCounts,
    launchOrder,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      launchOrder.push(stageId);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? {
        type: "throw" as const,
        message: `no behavior for ${stageId} attempt ${index + 1}`,
      };
      if (behavior.type === "throw") {
        throw new Error(behavior.message);
      }
      if (behavior.type === "fail") {
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => ({
            ok: false as const,
            reason: behavior.reason,
            ...(behavior.envelope !== undefined
              ? { envelope: behavior.envelope }
              : {}),
          }),
        });
      }
      if (behavior.type === "gate") {
        const gate = behavior.gate;
        const envelope = behavior.envelope ?? okEnvelope(stageId);
        const fail = behavior.fail;
        const reason = behavior.reason ?? "gated fail";
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            await gate;
            if (fail) {
              return { ok: false as const, reason };
            }
            return { ok: true as const, envelope };
          },
        });
      }
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => ({
          ok: true as const,
          envelope: behavior.envelope,
        }),
      });
    },
    async runStage(input) {
      const handle = agent.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
  return agent;
}

function recordingTracking(): RetryTrackingPort {
  return {
    async ensureResumeTracked() {
      return { ok: true, insertedForResume: true };
    },
    onOrchestrationStarted() {},
    async rollbackStartTracking() {},
  };
}

async function prepareCloneChainSequentialRun(root: string, agent: AgentPort) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const pipeline = pipelinePath("clone-chain-sequential");
  const loaded = await loadPipeline(pipeline, { cwd: fixtures });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    pipelinePath: pipeline,
    taskPath,
    projectRoot: fixtures,
  });
  return {
    prepared: {
      task,
      loaded,
      run: { runId: run.runId, workspaceDir: run.workspaceDir },
      agent,
      store,
      cwd: fixtures,
    },
    store,
    runId: run.runId,
  };
}

function notSuccess(status: string | undefined): boolean {
  return status !== "succeeded";
}

describe("Clone Chain sequential", () => {
  it("does not start ~2 until ~1 succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-seq-order-"));
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: () => void = () => undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: {
                items: [issue0, issue1, issue2],
                summary: "meta",
              },
            }),
          },
        ],
        "handle-item~1": [
          {
            type: "gate",
            gate: firstGate,
            envelope: okEnvelope("item-1", { payload: { id: "i-1" } }),
          },
        ],
        "handle-item~2": [
          {
            type: "gate",
            gate: secondGate,
            envelope: okEnvelope("item-2", { payload: { id: "i-2" } }),
          },
        ],
        "handle-item~3": [
          { type: "emit", envelope: okEnvelope("item-3", { payload: { id: "i-3" } }) },
        ],
        gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
      },
    });
    const { prepared } = await prepareCloneChainSequentialRun(root, agent);
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("handle-item~1") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("handle-item~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseFirst();
    await waitFor(() => (agent.openCounts.get("handle-item~2") ?? 0) === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(agent.openCounts.get("handle-item~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseSecond();
    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("handle-item~3")).toBe(1);
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.launchOrder.indexOf("handle-item~2")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~1"),
    );
    expect(agent.launchOrder.indexOf("handle-item~3")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~2"),
    );
    expect(agent.launchOrder.indexOf("gather")).toBeGreaterThan(
      agent.launchOrder.indexOf("handle-item~3"),
    );
  });

  it("skips later instances after ~1 fails, then retry continues the tail into the Join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-seq-retry-"));
    const agent = cloneChainAgent({
      behaviorsByStage: {
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted", {
              payload: {
                items: [issue0, issue1, issue2],
                summary: "meta",
              },
            }),
          },
        ],
        "handle-item~1": [
          { type: "fail", reason: "item-1 boom" },
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          { type: "emit", envelope: okEnvelope("item-2", { payload: { id: "i-2" } }) },
        ],
        "handle-item~3": [
          { type: "emit", envelope: okEnvelope("item-3", { payload: { id: "i-3" } }) },
        ],
        gather: [{ type: "emit", envelope: okEnvelope("gathered") }],
      },
    });
    const { prepared, store, runId } = await prepareCloneChainSequentialRun(
      root,
      agent,
    );
    const first = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(first.ok).toBe(false);
    expect(first.outcome).toBe("failed");
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    const afterFail = await store.readRun(runId);
    expect(afterFail.stages.find((s) => s.stage_id === "handle-item~1")?.status).toBe(
      "failed",
    );
    expect(afterFail.stages.find((s) => s.stage_id === "handle-item~2")?.status).toBe(
      "skipped",
    );
    expect(afterFail.stages.find((s) => s.stage_id === "handle-item~3")?.status).toBe(
      "skipped",
    );
    expect(
      notSuccess(afterFail.stages.find((s) => s.stage_id === "gather")?.status),
    ).toBe(true);

    const coordinator = new RunRetryCoordinator();
    const retried = await coordinator.retryStage({
      runId,
      stageId: "handle-item~1",
      store,
      agent,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      hitl: new StageHitlController({ store }),
      orchestrationConflict: false,
      tracking: recordingTracking(),
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    const done = await retried.done;
    expect(done?.ok).toBe(true);
    expect(done?.outcome).toBe("succeeded");
    expect(agent.openCounts.get("handle-item~1")).toBe(2);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("handle-item~3")).toBe(1);
    expect(agent.openCounts.get("gather")).toBe(1);
    expect(agent.launchOrder.indexOf("handle-item~2")).toBeGreaterThan(
      agent.launchOrder.lastIndexOf("handle-item~1"),
    );

    const afterRetry = await store.readRun(runId);
    expect(
      afterRetry.stages.find((s) => s.stage_id === "handle-item~1")?.status,
    ).toBe("succeeded");
    expect(
      afterRetry.stages.find((s) => s.stage_id === "handle-item~2")?.status,
    ).toBe("succeeded");
    expect(
      afterRetry.stages.find((s) => s.stage_id === "handle-item~3")?.status,
    ).toBe("succeeded");
    expect(afterRetry.stages.find((s) => s.stage_id === "gather")?.status).toBe(
      "succeeded",
    );
  });
});
