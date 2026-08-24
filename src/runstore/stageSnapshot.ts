import type { StageEnvelope } from "../types/envelope.js";
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

  if (latest !== null) {
    events = await store.listStageEvents(runId, stageId, latest.attempt);
    status = stageStatusFromEvents(events);
    envelope = await tryReadEnvelope(store, runId, stageId, latest);
    attempt_count = await store.countStageAttempts(runId, stageId);
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
  };
}
