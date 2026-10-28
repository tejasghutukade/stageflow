import {
  canAbandon,
  canResumeTimedOut,
  canRetry,
  type RetryStageSubject,
} from "../../stageAction";

export type StageActionVisibilityInput = {
  status: string;
  events: ReadonlyArray<{ event: string; reason?: string }>;
  retryBlocked: boolean;
  hasRetry: boolean;
  hasResume: boolean;
  hasAbandon: boolean;
  stage?: RetryStageSubject;
};

export type StageActionVisibility = {
  showRetry: boolean;
  showResume: boolean;
  showAbandon: boolean;
  retryDisabled: boolean;
};

export function stageActionVisibility(
  input: StageActionVisibilityInput,
): StageActionVisibility {
  const retrySubject: RetryStageSubject = input.stage ?? {
    status: input.status,
  };
  return {
    showRetry:
      input.hasRetry && (canRetry(retrySubject) || input.retryBlocked),
    showResume:
      input.hasResume &&
      canResumeTimedOut({ status: input.status, events: input.events }),
    showAbandon: input.hasAbandon && canAbandon(input.status),
    retryDisabled: input.retryBlocked,
  };
}
