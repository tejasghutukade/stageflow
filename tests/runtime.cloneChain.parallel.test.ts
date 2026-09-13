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

async function prepareCloneChainParallelRun(root: string, agent: AgentPort) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath("clone-chain-parallel"), {
    cwd: fixtures,
  });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
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

describe("Clone Chain parallel failure", () => {
  it("lets sibling instances finish after ~2 fails and does not run the Join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-par-fail-"));
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
            fail: true,
            reason: "item-2 boom",
          },
        ],
        "handle-item~3": [
          { type: "emit", envelope: okEnvelope("item-3", { payload: { id: "i-3" } }) },
        ],
        gather: [{ type: "throw", message: "gather must not run" }],
      },
    });
    const { prepared, store, runId } = await prepareCloneChainParallelRun(
      root,
      agent,
    );
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 2,
      executionMode: "inprocess",
    });

    await waitFor(() => (agent.openCounts.get("handle-item~1") ?? 0) === 1);
    await waitFor(() => (agent.openCounts.get("handle-item~2") ?? 0) === 1);
    expect(agent.openCounts.get("handle-item~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseSecond();
    await waitFor(() => (agent.openCounts.get("handle-item~3") ?? 0) === 1);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    releaseFirst();
    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("handle-item~3")).toBe(1);
    expect(agent.openCounts.get("gather") ?? 0).toBe(0);

    const detail = await store.readRun(runId);
    expect(detail.stages.find((s) => s.stage_id === "handle-item~1")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "handle-item~2")?.status).toBe(
      "failed",
    );
    expect(detail.stages.find((s) => s.stage_id === "handle-item~3")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "gather")?.status).toBe(
      "pending",
    );
  });
});
