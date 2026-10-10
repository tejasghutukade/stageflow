import type { StageEnvelope } from "../types/envelope.js";
import { addModelUsage, emptyStageUsage, type StageUsage } from "../types/usage.js";
import { derivePendingPrompt } from "../hitl/qaTrail.js";
import type { RunStore, StageExecution, StageLogEvent, StageSnapshot } from "./port.js";
import { stageStatusFromEvents } from "./port.js";
import { listArtifactNames } from "./workspaceLayout.js";

async function tryReadEnvelope(
  store: RunStore,
  runId: string,
  stageId: string,
  latest: StageExecution | null,
): Promise<StageEnvelope | null> {
  if (latest?.envelope != null) {
    return latest.envelope;
  }
  try {
    return await store.readEnvelope(runId, stageId);
  } catch {
    return null;
  }
}

export async function buildStageSnapshotFromStore(
  store: RunStore,
  runId: string,
  stageId: string,
  workspaceDir: string,
): Promise<StageSnapshot> {
  const latest = await store.getLatestStageExecution(runId, stageId);

  let events: StageLogEvent[];
  let status: StageSnapshot["status"];
  let envelope: StageEnvelope | null;
  let attempt_count: number;
  let cost_usd: number | undefined;
  let usage: StageUsage | undefined;

  if (latest !== null) {
    events = await store.listStageEvents(runId, stageId, latest.attempt);
    status = stageStatusFromEvents(events);
    envelope = await tryReadEnvelope(store, runId, stageId, latest);
    attempt_count = await store.countStageAttempts(runId, stageId);
    const executions = await store.listStageExecutions(runId, stageId);
    cost_usd = sumStageExecutionCost(executions);
    usage = mergeStageExecutionUsage(executions);
  } else {
    events = await store.listStageEvents(runId, stageId);
    status = stageStatusFromEvents(events);
    envelope = await tryReadEnvelope(store, runId, stageId, null);
    attempt_count = 1;
  }

  const artifacts = await listArtifactNames(
    workspaceDir,
    stageId,
    latest?.attempt ?? 1,
  );
  const last_at = events.length > 0 ? events[events.length - 1]?.at : undefined;
  const pending = derivePendingPrompt(events);
  return {
    stage_id: stageId,
    status,
    events,
    envelope,
    artifacts,
    last_at,
    attempt_count,
    ...(pending ? { pending_prompt: pending } : {}),
    ...(cost_usd !== undefined ? { cost_usd } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function mergeStageExecutionUsage(
  executions: StageExecution[],
): StageUsage | undefined {
  const usages = executions
    .map((e) => e.usage)
    .filter((u): u is StageUsage => u !== undefined);
  if (usages.length === 0) return undefined;
  const merged = emptyStageUsage();
  for (const u of usages) {
    for (const [model, breakdown] of Object.entries(u.models)) {
      addModelUsage(merged, model, breakdown);
    }
  }
  merged.costUsd = usages.reduce((sum, u) => sum + u.costUsd, 0);
  return merged;
}

/** Sum cost across every attempt — retries are real spend too, so a stage's total isn't just its latest attempt. */
function sumStageExecutionCost(executions: StageExecution[]): number | undefined {
  const costs = executions.map((e) => e.cost_usd).filter((c): c is number => c !== undefined);
  if (costs.length === 0) return undefined;
  return costs.reduce((sum, c) => sum + c, 0);
}
