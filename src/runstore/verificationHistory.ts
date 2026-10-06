import type {
  RunStore,
  StageExecution,
  VerificationCheckResult,
} from "./port.js";
import {
  manualRecoveryHistory,
  readManualRecoveryState,
} from "../runtime/manualRecoveryState.js";

/**
 * The audit trail for every execution of one stage. This is deliberately a
 * stage-scoped read model: command output and other check evidence can be
 * substantial, so it does not belong in a run listing or summary.
 */
export type StageVerificationAttempt = Pick<
  StageExecution,
  "attempt" | "status" | "verification_outcome" | "started_at" | "finished_at"
> & {
  checks: VerificationCheckResult[];
};

export type StageVerificationHistory = {
  run_id: string;
  stage_id: string;
  attempts: StageVerificationAttempt[];
  manual_recovery?: {
    status: "available" | "stopped";
    failed_attempt: number;
  };
};

export async function readStageVerificationHistory(
  store: RunStore,
  runId: string,
  stageId: string,
): Promise<StageVerificationHistory> {
  const run = await store.readRun(runId);
  if (!run.stages.some((stage) => stage.stage_id === stageId)) {
    throw new Error(`Stage not found: ${stageId}`);
  }

  const executions = await store.listStageExecutions(runId, stageId);
  const attempts = await Promise.all(
    executions.map(async (execution) => ({
      attempt: execution.attempt,
      status: execution.status,
      verification_outcome: execution.verification_outcome,
      ...(execution.started_at !== undefined
        ? { started_at: execution.started_at }
        : {}),
      ...(execution.finished_at !== undefined
        ? { finished_at: execution.finished_at }
        : {}),
      checks: await store.listVerificationCheckResults(
        runId,
        stageId,
        execution.attempt,
      ),
    })),
  );

  const recovery = manualRecoveryHistory(
    await readManualRecoveryState(store, runId, stageId),
  );
  if (recovery === undefined) {
    return { run_id: runId, stage_id: stageId, attempts };
  }
  return {
    run_id: runId,
    stage_id: stageId,
    attempts,
    manual_recovery: recovery,
  };
}
