import {
  findUnhandledFailedStage,
  type RunDetail,
  type RunPipelineDagSnapshot,
  type RunStatus,
  type StageSnapshot,
} from "../runstore/port.js";
import { isRunClockTerminal } from "../runstore/runStatusClock.js";

export type StageRetrySubject = Pick<
  StageSnapshot,
  "stage_id" | "status" | "definition_id" | "envelope"
>;

export type RunActionEligibilityInput = {
  runStatus: RunStatus;
  stage?: StageRetrySubject;
  stages?: ReadonlyArray<Pick<StageSnapshot, "status" | "stage_id">>;
  recoveryActive?: boolean;
  dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null;
};

export type RunActionEligibility = {
  canRetry: boolean;
  canCancel: boolean;
  canAbandon: boolean;
  blockers: string[];
};

export function resumesRunOnStageRetry(status: RunStatus): boolean {
  return isRunClockTerminal(status);
}

export function canCancelRun(status: RunStatus): boolean {
  return status !== "succeeded" && status !== "failed";
}

export function canAbandonStage(stageStatus: string): boolean {
  return stageStatus === "running";
}

export function succeededStageRetryBlocker(
  stageSnap: StageRetrySubject,
): string | undefined {
  if (
    stageSnap.definition_id !== undefined &&
    stageSnap.definition_id !== stageSnap.stage_id
  ) {
    return `Cannot re-run a succeeded clone instance stage (stage=${stageSnap.stage_id}, definition=${stageSnap.definition_id}): clone instances are created by upstream fan-out and cannot be rebuilt in place. Use rerun to start a new run.`;
  }
  if (stageSnap.envelope?.fork_choice !== undefined) {
    return `Cannot re-run a succeeded fork stage (stage=${stageSnap.stage_id}): its envelope recorded a fork_choice and skipped branches cannot be restored. Use rerun to start a new run.`;
  }
  return undefined;
}

export function stageRetryBlocker(
  input: {
    runStatus: RunStatus;
    stage: StageRetrySubject;
    stages?: ReadonlyArray<Pick<StageSnapshot, "status" | "stage_id">>;
    recoveryActive?: boolean;
    dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null;
  },
): string | undefined {
  const { stage, runStatus } = input;
  if (stage.status === "waiting_for_input") {
    return `Stage is waiting for input and cannot be retried`;
  }

  const recoveryActive = input.recoveryActive === true;
  if (!resumesRunOnStageRetry(runStatus)) {
    const stages = input.stages ?? [];
    const acceptedPendingRetry =
      runStatus === "running" &&
      stage.status === "failed" &&
      findUnhandledFailedStage(
        stages as StageSnapshot[],
        input.dag,
      ) === undefined &&
      stages.some((s) => s.status === "pending");
    if (!(runStatus === "running" && recoveryActive) && !acceptedPendingRetry) {
      return `Run is not failed or succeeded (status=${runStatus})`;
    }
  }

  if (stage.status !== "failed" && stage.status !== "succeeded") {
    return `Stage is not failed or succeeded (status=${stage.status})`;
  }

  if (stage.status === "succeeded") {
    return succeededStageRetryBlocker(stage);
  }

  return undefined;
}

export function canRetryStage(input: {
  runStatus: RunStatus;
  stage: StageRetrySubject;
  stages?: ReadonlyArray<Pick<StageSnapshot, "status" | "stage_id">>;
  recoveryActive?: boolean;
  dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null;
}): boolean {
  return stageRetryBlocker(input) === undefined;
}

export function runActionEligibility(
  input: RunActionEligibilityInput,
): RunActionEligibility {
  const blockers: string[] = [];
  const canCancel = canCancelRun(input.runStatus);
  if (!canCancel) {
    blockers.push(`Run is ${input.runStatus} and cannot be cancelled`);
  }

  const canAbandon =
    input.stage !== undefined && canAbandonStage(input.stage.status);
  if (input.stage !== undefined && !canAbandon) {
    blockers.push(
      `Stage is not running (status=${input.stage.status})`,
    );
  }

  let canRetry = false;
  if (input.stage === undefined) {
    blockers.push("Stage is required to retry");
  } else {
    const retryBlocker = stageRetryBlocker({
      runStatus: input.runStatus,
      stage: input.stage,
      stages: input.stages,
      recoveryActive: input.recoveryActive,
      dag: input.dag,
    });
    if (retryBlocker === undefined) {
      canRetry = true;
    } else {
      blockers.push(retryBlocker);
    }
  }

  return { canRetry, canCancel, canAbandon, blockers };
}

export function assertStageRetryEligible(
  detail: RunDetail,
  stageId: string,
  opts?: {
    recoveryActive?: boolean;
    persistedStatus?: RunStatus;
    dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null;
  },
): {
  ok: true;
} | { ok: false; reason: string; status: number; code: string } {
  const stageSnap = detail.stages.find((s) => s.stage_id === stageId);
  if (!stageSnap) {
    return {
      ok: false,
      reason: `Stage not found: ${stageId}`,
      status: 404,
      code: "stage_not_found",
    };
  }

  const runStatus = opts?.persistedStatus ?? detail.status;
  const blocker = stageRetryBlocker({
    runStatus,
    stage: stageSnap,
    stages: detail.stages,
    recoveryActive: opts?.recoveryActive,
    dag: opts?.dag,
  });
  if (blocker === undefined) {
    return { ok: true };
  }

  if (blocker.includes("waiting for input")) {
    return {
      ok: false,
      reason: blocker,
      status: 409,
      code: "hitl_not_retriable",
    };
  }

  if (blocker.startsWith("Stage is not failed or succeeded")) {
    return {
      ok: false,
      reason: blocker,
      status: 409,
      code: "stage_not_failed",
    };
  }

  return {
    ok: false,
    reason: blocker,
    status: 409,
    code: "run_not_retryable",
  };
}
