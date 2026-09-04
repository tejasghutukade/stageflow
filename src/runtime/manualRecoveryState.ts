import type { RunStore, StageSnapshot } from "../runstore/port.js";

/**
 * The derived recovery state of one stage. It deliberately separates the
 * operator policy decision from the orchestration that starts an attempt.
 */
export type ManualRecoveryState =
  | { kind: "not_manual" }
  | { kind: "stage_not_found" }
  | { kind: "not_failed"; status: StageSnapshot["status"] }
  | { kind: "not_verification_failure" }
  | { kind: "available"; failedAttempt: number }
  | { kind: "stopped"; failedAttempt: number };

export type ManualRecoveryEligibility =
  | { ok: true; failedAttempt: number }
  | { ok: false; reason: string; status: number };

/**
 * Interpret the persisted DAG and stage events for a manual-recovery stage.
 * Callers decide what to do with that state; this module owns what it means.
 */
export async function readManualRecoveryState(
  store: RunStore,
  runId: string,
  stageId: string,
): Promise<ManualRecoveryState> {
  const [detail, meta, latestExecution] = await Promise.all([
    store.readRun(runId),
    store.readRunMeta(runId),
    store.getLatestStageExecution(runId, stageId),
  ]);
  const stage = detail.stages.find((item) => item.stage_id === stageId);
  if (!stage) return { kind: "stage_not_found" };

  const recovery = meta.pipeline_dag?.nodes.find(
    (node) => node.id === stageId,
  )?.recovery;
  if (recovery?.mode !== "manual") return { kind: "not_manual" };
  if (stage.status !== "failed") {
    return { kind: "not_failed", status: stage.status };
  }
  if (latestExecution === null) return { kind: "not_verification_failure" };

  const events = await store.listStageEvents(
    runId,
    stageId,
    latestExecution.attempt,
  );
  if (latestExecution.verification_outcome !== "failed") {
    return { kind: "not_verification_failure" };
  }
  if (events.some((event) => event.event === "manual_recovery_stopped")) {
    return { kind: "stopped", failedAttempt: latestExecution.attempt };
  }
  return { kind: "available", failedAttempt: latestExecution.attempt };
}

export function manualRecoveryEligibility(
  state: ManualRecoveryState,
): ManualRecoveryEligibility {
  switch (state.kind) {
    case "available":
      return { ok: true, failedAttempt: state.failedAttempt };
    case "not_manual":
      return {
        ok: false,
        reason: "Stage is not configured for manual recovery",
        status: 409,
      };
    case "stage_not_found":
      return { ok: false, reason: "Stage not found", status: 404 };
    case "not_failed":
      return {
        ok: false,
        reason: `Stage is not failed (status=${state.status})`,
        status: 409,
      };
    case "not_verification_failure":
      return {
        ok: false,
        reason:
          "Manual recovery is only available after a completion verification failure",
        status: 409,
      };
    case "stopped":
      return {
        ok: false,
        reason: "Manual recovery has been stopped for this stage",
        status: 409,
      };
  }
}

export function blocksGenericRetry(state: ManualRecoveryState): boolean {
  return state.kind === "available" || state.kind === "stopped";
}

export function manualRecoveryHistory(
  state: ManualRecoveryState,
): { status: "available" | "stopped"; failed_attempt: number } | undefined {
  if (state.kind !== "available" && state.kind !== "stopped") return undefined;
  return {
    status: state.kind,
    failed_attempt: state.failedAttempt,
  };
}
