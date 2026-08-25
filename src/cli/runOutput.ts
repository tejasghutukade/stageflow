import type { PipelineRunResult } from "../runtime/pipelineRunner.js";
import type { BusyCode, StartRunResult } from "../runtime/runManager.js";
import { STAGE_WORKER_EXIT } from "../runtime/stageWorkerProtocol.js";

function stringify(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

function isBusyCode(code: string | undefined): code is BusyCode {
  return code === "busy_capacity" || code === "busy_checkout";
}

export function formatRunBusyJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "busy",
  };
  if (started.code !== undefined) payload.code = started.code;
  payload.reason = started.reason;
  if (started.activeCount !== undefined) payload.activeCount = started.activeCount;
  if (started.maxConcurrent !== undefined) {
    payload.maxConcurrent = started.maxConcurrent;
  }
  if (started.activeRunIds !== undefined) {
    payload.activeRunIds = started.activeRunIds;
  }
  if (started.conflictingRunId !== undefined) {
    payload.conflictingRunId = started.conflictingRunId;
  }
  if (started.conflictingCheckout !== undefined) {
    payload.conflictingCheckout = started.conflictingCheckout;
  }
  return stringify(payload);
}

export function formatRunStartFailedJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "failed",
    reason: started.reason,
  };
  if (started.code !== undefined) payload.code = started.code;
  return stringify(payload);
}

export function formatStartFailureJson(
  started: Extract<StartRunResult, { ok: false }>,
): string {
  if (isBusyCode(started.code)) {
    return formatRunBusyJson(started);
  }
  return formatRunStartFailedJson(started);
}

export function formatRunCompletionJson(result: PipelineRunResult): string {
  if (result.outcome === "succeeded") {
    return stringify({
      ok: true,
      outcome: "succeeded",
      runId: result.runId,
      runDir: result.runDir,
    });
  }
  if (result.outcome === "waiting") {
    return stringify({
      ok: false,
      outcome: "waiting",
      runId: result.runId,
      runDir: result.runDir,
    });
  }
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: "failed",
    runId: result.runId,
    runDir: result.runDir,
  };
  if (result.reason !== undefined) payload.reason = result.reason;
  return stringify(payload);
}

export function exitCodeForRunOutcome(
  outcome: PipelineRunResult["outcome"],
): number {
  switch (outcome) {
    case "succeeded":
      return STAGE_WORKER_EXIT.SUCCEEDED;
    case "waiting":
      return STAGE_WORKER_EXIT.WAITING;
    case "failed":
      return STAGE_WORKER_EXIT.FAILED;
  }
}
