import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../../src/config/loadPipeline.js";
import { buildPipelineDagSnapshotFromLoaded } from "../../src/runstore/pipelineDagSnapshot.js";
import type { RunStatus, RunStore, StageSnapshot } from "../../src/runstore/port.js";
import { pipelinePath } from "./fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export async function seedDiamondRun(
  store: RunStore,
  stem: "diamond-fan-in" | "diamond-fan-in-accepted",
  stages: Record<string, StageSnapshot["status"]>,
  runStatus?: RunStatus,
): Promise<{ runId: string }> {
  const loaded = await loadPipeline(pipelinePath(stem), { cwd: fixtures });
  const created = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml: "id: t\ngoal: g\n",
    taskId: "t",
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    pipelinePath: pipelinePath(stem),
  });

  for (const [stageId, status] of Object.entries(stages)) {
    await store.ensureStageWorkspace(created.runId, stageId);
    if (status === "pending") continue;
    await store.createStageExecution(created.runId, stageId);
    await store.appendStageEvent(created.runId, stageId, { event: "started" });
    if (status === "failed") {
      await store.appendStageEvent(created.runId, stageId, {
        event: "failed",
        reason: `${stageId} boom`,
      });
    } else if (status === "skipped") {
      await store.appendStageEvent(created.runId, stageId, { event: "skipped" });
    } else if (status === "waiting_for_input") {
      await store.appendStageEvent(created.runId, stageId, {
        event: "waiting_for_input",
      });
    } else if (status === "succeeded") {
      await store.appendStageEvent(created.runId, stageId, { event: "succeeded" });
    }
  }

  if (runStatus !== undefined && runStatus !== "created") {
    await store.updateRunStatus(created.runId, runStatus);
  }

  return { runId: created.runId };
}
