export function canRetry(status: string): boolean {
  return status === "failed";
}

export function canAbandon(status: string): boolean {
  return status === "running";
}

export type StageActionBusyState = {
  retryingStageIds: ReadonlySet<string>;
  abandoningStageId: string | null;
};

export function isStageActionBusy(
  state: StageActionBusyState,
  stageId: string,
): boolean {
  return state.retryingStageIds.has(stageId) || state.abandoningStageId === stageId;
}
