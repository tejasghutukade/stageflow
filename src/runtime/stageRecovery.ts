import type { RunStore, StageLogEvent } from "../runstore/port.js";
import { deriveStatusFromStages } from "../runstore/port.js";
import { deriveExecutionPatchFromEvent } from "../runstore/stageExecution.js";
import {
  attemptContext,
  type StageAttemptContext,
} from "./stageAttemptContext.js";

export async function failStageAsInterrupted(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  reason: string;
  attemptCtx?: StageAttemptContext;
}): Promise<void> {
  const { store, runId, stageId, reason, attemptCtx } = options;

  let attemptNum: number;
  let attemptOpt: { attempt: number } | undefined;

  if (attemptCtx !== undefined) {
    attemptNum = attemptCtx.attempt;
    attemptOpt = attemptCtx.eventOptions();
  } else {
    const latest = await store.getLatestStageExecution(runId, stageId);
    if (latest !== null) {
      attemptNum = latest.attempt;
      attemptOpt = attemptContext(latest.attempt).eventOptions();
    } else {
      attemptNum = 1;
      attemptOpt = undefined;
    }
  }

  const event: StageLogEvent = { event: "failed", reason };
  await store.appendStageEvent(runId, stageId, event, attemptOpt);

  try {
    const execution = await store.getStageExecution(runId, stageId, attemptNum);
    const patch = deriveExecutionPatchFromEvent(event, execution);
    if (Object.keys(patch).length === 0) return;
    await store.updateStageExecution(runId, stageId, attemptNum, patch);
  } catch {
    // no execution row yet
  }
}

export async function syncRunStatusFromStages(
  store: RunStore,
  runId: string,
): Promise<void> {
  const run = await store.readRun(runId);
  const derived = deriveStatusFromStages(run.stages);
  const meta = await store.readRunMeta(runId);
  if ((meta.status ?? "created") !== derived) {
    await store.updateRunStatus(runId, derived);
  }
}
