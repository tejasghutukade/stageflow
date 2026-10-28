export type RetryStageSubject = {
  status: string;
  stage_id?: string;
  definition_id?: string;
  envelope?: { fork_choice?: unknown } | null;
};

export function succeededStageRetryBlocker(
  stage: RetryStageSubject,
): string | undefined {
  if (
    stage.definition_id !== undefined &&
    stage.stage_id !== undefined &&
    stage.definition_id !== stage.stage_id
  ) {
    return `Cannot re-run a succeeded clone instance stage (stage=${stage.stage_id}, definition=${stage.definition_id}): clone instances are created by upstream fan-out and cannot be rebuilt in place. Use rerun to start a new run.`;
  }
  if (stage.envelope?.fork_choice !== undefined) {
    return `Cannot re-run a succeeded fork stage (stage=${stage.stage_id ?? "?"}): its envelope recorded a fork_choice and skipped branches cannot be restored. Use rerun to start a new run.`;
  }
  return undefined;
}

export function canRetry(stage: string | RetryStageSubject): boolean {
  const subject =
    typeof stage === "string" ? { status: stage } : stage;
  if (subject.status === "failed") return true;
  if (subject.status !== "succeeded") return false;
  return succeededStageRetryBlocker(subject) === undefined;
}

export function canAbandon(status: string): boolean {
  return status === "running";
}

export function canResumeTimedOut(stage: {
  status: string;
  events: ReadonlyArray<{ event: string; reason?: string }>;
}): boolean {
  if (stage.status === "interrupted") return true;
  if (stage.status !== "failed") return false;
  let reason: string | undefined;
  for (const event of stage.events) {
    if (event.event === "failed") reason = event.reason;
  }
  return (
    typeof reason === "string" && reason.startsWith("stage timed out after ")
  );
}

export type StageActionBusyState = {
  retryingStageIds: ReadonlySet<string>;
  abandoningStageId: string | null;
  resumingStageIds?: ReadonlySet<string>;
};

export function isStageActionBusy(
  state: StageActionBusyState,
  stageId: string,
): boolean {
  return (
    state.retryingStageIds.has(stageId) ||
    state.abandoningStageId === stageId ||
    (state.resumingStageIds?.has(stageId) ?? false)
  );
}
