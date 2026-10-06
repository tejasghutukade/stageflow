export function canRetry(status: string): boolean {
  return status === "failed";
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
