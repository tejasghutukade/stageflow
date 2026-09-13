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

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function cloneChainLoopAgent(options: {
  behaviorsByStage: Record<
    string,
    Array<{ type: "emit"; envelope: StageEnvelope }>
  >;
}): AgentPort & { openCounts: Map<string, number> } {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const agent: AgentPort & { openCounts: Map<string, number> } = {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index];
      if (behavior === undefined) {
        throw new Error(`no behavior for ${stageId} attempt ${index + 1}`);
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

describe("Clone Chain Join Loop pipeline run", () => {
  it("replays from the Join to a stage before the emitter using existing Loop policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-chain-loop-"));
    const itemsPayload = {
      items: [issue0, issue1],
      summary: "meta",
    };
    const agent = cloneChainLoopAgent({
      behaviorsByStage: {
        prepare: [
          { type: "emit", envelope: okEnvelope("prepare-1") },
          { type: "emit", envelope: okEnvelope("prepare-2") },
        ],
        "emit-items": [
          {
            type: "emit",
            envelope: okEnvelope("emitted-1", { payload: itemsPayload }),
          },
          {
            type: "emit",
            envelope: okEnvelope("emitted-2", { payload: itemsPayload }),
          },
        ],
        "handle-item~1": [
          { type: "emit", envelope: okEnvelope("item-1", { payload: { id: "i-1" } }) },
        ],
        "handle-item~2": [
          { type: "emit", envelope: okEnvelope("item-2", { payload: { id: "i-2" } }) },
        ],
        "handle-item~3": [
          { type: "emit", envelope: okEnvelope("item-1b", { payload: { id: "i-1" } }) },
        ],
        "handle-item~4": [
          { type: "emit", envelope: okEnvelope("item-2b", { payload: { id: "i-2" } }) },
        ],
        gather: [
          {
            type: "emit",
            envelope: okEnvelope("send-back", {
              feedback_loop: { action: "send_back", target: "prepare" },
            }),
          },
          {
            type: "emit",
            envelope: okEnvelope("continue", {
              feedback_loop: { action: "continue" },
            }),
          },
        ],
        done: [{ type: "emit", envelope: okEnvelope("done-ok") }],
      },
    });

    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("clone-chain-loop-from-join"), {
      cwd: fixtures,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("prepare")).toBe(2);
    expect(agent.openCounts.get("emit-items")).toBe(2);
    expect(agent.openCounts.get("handle-item~1")).toBe(1);
    expect(agent.openCounts.get("handle-item~2")).toBe(1);
    expect(agent.openCounts.get("handle-item~3")).toBe(1);
    expect(agent.openCounts.get("handle-item~4")).toBe(1);
    expect(agent.openCounts.get("handle-item") ?? 0).toBe(0);
    expect(agent.openCounts.get("gather")).toBe(2);
    expect(agent.openCounts.get("done")).toBe(1);

    const detail = await store.readRun(run.runId);
    expect(detail.feedback_loops).toHaveLength(1);
    const history = detail.feedback_loops![0]!;
    expect(history.loop.state).toBe("continued");
    expect(history.replays).toHaveLength(1);
    expect(history.replays[0]!.replay.route_stage_ids).toEqual([
      "prepare",
      "emit-items",
      "handle-item",
      "gather",
    ]);
  });
});
