import type {
  RetryStageResult,
  StartRunResult,
} from "../runtime/runManager.js";

export function inferRetryStageErrorCode(reason: string): string | undefined {
  if (/retry already in progress/i.test(reason)) return "retry_in_progress";
  if (/waiting for input/i.test(reason)) return "hitl_not_retriable";
  if (/already has active orchestration/i.test(reason)) return "run_not_retryable";
  if (/run is not failed/i.test(reason)) return "run_not_retryable";
  if (/stage is not failed/i.test(reason)) return "stage_not_failed";
  if (/manual recovery/i.test(reason)) return "manual_recovery_required";
  return undefined;
}

export function mapRetryStageFailure(
  result: Extract<RetryStageResult, { ok: false }>,
): { error: string; code?: string } & Record<string, unknown> {
  const { ok: _ok, status: _status, reason, ...rest } = result;
  const code = inferRetryStageErrorCode(reason);
  return { error: reason, ...(code ? { code } : {}), ...rest };
}

export function mapStartFailure(
  result: Extract<StartRunResult, { ok: false }>,
): { error: string } & Record<string, unknown> {
  const { ok: _ok, status: _status, reason, ...rest } = result;
  return { error: reason, ...rest };
}
