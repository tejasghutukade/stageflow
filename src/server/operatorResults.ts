import type {
  RetryStageResult,
  StartRunResult,
} from "../runtime/runManager.js";
import { codeOrInternal } from "../errors/codes.js";

export function mapRetryStageFailure(
  result: Extract<RetryStageResult, { ok: false }>,
): { error: string; code: string } & Record<string, unknown> {
  const { ok: _ok, status: _status, reason, code, ...rest } = result;
  return { error: reason, code: codeOrInternal(code), ...rest };
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
  code: string;
};

function storeLookupCode(kind: StoreLookupKind, policy: StoreLookupPolicy): string {
  if (kind === "denied") return "artifact_path_denied";
  if (kind === "not_found") {
    if (policy === "artifact") return "artifact_not_found";
    if (policy === "envelope") return "envelope_not_found";
    return "run_not_found";
  }
  return "internal_error";
}

function classifyStoreMessage(
  error: string,
  policy: StoreLookupPolicy,
): { kind: StoreLookupKind; status: number } {
  if (policy === "artifact") {
    if (error === "Artifact path denied") {
      return { kind: "denied", status: 400 };
    }
    const notFound =
      error.startsWith("Run not found") ||
      error.startsWith("Artifact not found") ||
      error.startsWith("Checkout file not found");
    return {
      kind: notFound ? "not_found" : "error",
      status: notFound ? 404 : 400,
    };
  }

  if (policy === "envelope") {
    const notFound =
      error.startsWith("Envelope not found") ||
      error.startsWith("Run not found") ||
      error.startsWith("Stage execution not found");
    return {
      kind: notFound ? "not_found" : "error",
      status: notFound ? 404 : 500,
    };
  }

  const notFound =
    error.startsWith("Run not found") || error.startsWith("unknown run");
  return {
    kind: notFound ? "not_found" : "error",
    status: notFound ? 404 : 500,
  };
}

export function mapStoreLookupError(
  err: unknown,
  opts: { policy: StoreLookupPolicy },
): StoreLookupMapped {
  const error = err instanceof Error ? err.message : String(err);
  const classified = classifyStoreMessage(error, opts.policy);
  return {
    error,
    status: classified.status,
    kind: classified.kind,
    code: storeLookupCode(classified.kind, opts.policy),
  };
}
