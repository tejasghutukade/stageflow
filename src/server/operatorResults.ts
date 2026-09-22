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

export type StoreLookupPolicy = "run" | "artifact" | "envelope";

export type StoreLookupKind = "not_found" | "denied" | "error";

export type StoreLookupMapped = {
  error: string;
  status: number;
  kind: StoreLookupKind;
};

export function mapStoreLookupError(
  err: unknown,
  opts: { policy: StoreLookupPolicy },
): StoreLookupMapped {
  const error = err instanceof Error ? err.message : String(err);

  if (opts.policy === "artifact") {
    if (error === "Artifact path denied") {
      return { error, status: 400, kind: "denied" };
    }
    const notFound =
      error.startsWith("Run not found") ||
      error.startsWith("Artifact not found") ||
      error.startsWith("Checkout file not found") ||
      /no such|not found/i.test(error);
    return {
      error,
      status: notFound ? 404 : 400,
      kind: notFound ? "not_found" : "error",
    };
  }

  const notFound =
    opts.policy === "envelope"
      ? /not found|no such|envelope/i.test(error)
      : /not found|no such|unknown run/i.test(error);
  return {
    error,
    status: notFound ? 404 : 500,
    kind: notFound ? "not_found" : "error",
  };
}
