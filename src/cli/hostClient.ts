import path from "node:path";
import type { ValidationResult } from "../config/validateCatalog.js";
import { globalStageflowHome } from "../project/globalHome.js";
import type { PipelineRunResult } from "../runtime/pipelineRunner.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import type {
  AbandonStageResult,
  DecideFeedbackLoopResult,
  StartRunResult,
  StopManualRecoveryResult,
} from "../runtime/runManager.js";
import type { DeliverAnswerResult } from "../runtime/stageHitl.js";
import type { RetryStageResult } from "../runtime/runRetryCoordinator.js";
import { runWorkspaceDir, storeRootFor } from "../runstore/paths.js";
import type { RunDetail, RunStore } from "../runstore/port.js";

async function postJson(
  base: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await parseJsonBody(res) };
}

async function getJson(
  base: string,
  urlPath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${urlPath}`);
  return { status: res.status, body: await parseJsonBody(res) };
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `request to global Stageflow service failed (status ${status})`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export function computeRunDir(runId: string): string {
  return runWorkspaceDir(storeRootFor(globalStageflowHome()), runId);
}

export async function httpReadRun(base: string, runId: string): Promise<RunDetail> {
  const { status, body } = await getJson(base, `/api/runs/${enc(runId)}`);
  if (status !== 200) {
    throw new Error(extractError(body, status));
  }
  return body as RunDetail;
}

/** Thin RunStore-shaped reader backed by the global service, for the CLI output helpers that only need `readRun`. */
export function httpStoreReader(base: string): Pick<RunStore, "readRun"> {
  return { readRun: (runId: string) => httpReadRun(base, runId) };
}

function isRunTerminal(detail: RunDetail): boolean {
  return (
    detail.status === "succeeded" ||
    detail.status === "failed" ||
    (detail.status === "running" && detail.waiting_stage_id !== undefined)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollRunUntilTerminal(
  base: string,
  runId: string,
  options?: { pollIntervalMs?: number },
): Promise<RunDetail> {
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  for (;;) {
    const detail = await httpReadRun(base, runId);
    if (isRunTerminal(detail)) return detail;
    await sleep(pollIntervalMs);
  }
}

export function runDetailToPipelineRunResult(detail: RunDetail): PipelineRunResult {
  const outcome: PipelineRunResult["outcome"] =
    detail.status === "succeeded"
      ? "succeeded"
      : detail.status === "failed"
        ? "failed"
        : "waiting";
  return {
    ok: outcome === "succeeded",
    outcome,
    runId: detail.run_id,
    runDir: computeRunDir(detail.run_id),
    ...(outcome === "failed" && detail.failed_reason !== undefined
      ? { reason: detail.failed_reason }
      : {}),
  };
}

function toStartFailure(
  status: number,
  body: unknown,
): Extract<StartRunResult, { ok: false }> {
  const rest: Record<string, unknown> =
    body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {};
  const error = typeof rest.error === "string" ? rest.error : undefined;
  delete rest.error;
  return {
    ok: false,
    reason: error ?? extractError(body, status),
    status,
    ...rest,
  };
}

export type HttpStartRunInput = {
  pipeline: string;
  task: string;
  checkoutOverride?: string;
  skipGates?: boolean;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
};

function validationResultFrom(body: unknown): ValidationResult | undefined {
  if (body && typeof body === "object" && "validation" in body) {
    return (body as { validation: ValidationResult }).validation;
  }
  return undefined;
}

export async function httpStartRun(
  base: string,
  input: HttpStartRunInput,
): Promise<StartRunResult> {
  const { status, body } = await postJson(base, "/api/runs", input);
  if (status === 400) {
    const validation = validationResultFrom(body);
    if (validation !== undefined) throw new PipelineValidationError(validation);
  }
  if (status !== 202) return toStartFailure(status, body);
  const runId = (body as { runId: string }).runId;
  return {
    ok: true,
    runId,
    done: pollRunUntilTerminal(base, runId).then(runDetailToPipelineRunResult),
  };
}

export async function httpRerun(base: string, runId: string): Promise<StartRunResult> {
  const { status, body } = await postJson(base, `/api/runs/${enc(runId)}/rerun`, {});
  if (status !== 202) return toStartFailure(status, body);
  const newRunId = (body as { runId: string }).runId;
  return {
    ok: true,
    runId: newRunId,
    done: pollRunUntilTerminal(base, newRunId).then(runDetailToPipelineRunResult),
  };
}

export async function httpDeliverAnswer(
  base: string,
  runId: string,
  stageId: string,
  answer: unknown,
): Promise<DeliverAnswerResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/answer`,
    answer,
  );
  if (status === 202) return { ok: true };
  return { ok: false, reason: extractError(body, status), status: status as 404 | 409 | 400 | 500 };
}

export async function httpDecideFeedbackLoop(
  base: string,
  runId: string,
  stageId: string,
  input: { decision: "extend" | "continue" | "abandon"; loopId?: string; reason?: string },
): Promise<DecideFeedbackLoopResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/feedback-decision`,
    input,
  );
  if (status === 202) {
    const parsed = body as Extract<DecideFeedbackLoopResult, { ok: true }>;
    return { ok: true, effect: parsed.effect, loopId: parsed.loopId };
  }
  return { ok: false, reason: extractError(body, status), status };
}

type RetryOrchestrationResult =
  | { ok: true; pipeline: PipelineRunResult }
  | Extract<RetryStageResult, { ok: false }>;

export async function httpRetryStageUntilStop(
  base: string,
  runId: string,
  stageId: string,
): Promise<RetryOrchestrationResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/retry`,
    {},
  );
  if (status !== 202) {
    return { ok: false, reason: extractError(body, status), status };
  }
  const detail = await pollRunUntilTerminal(base, runId);
  return { ok: true, pipeline: runDetailToPipelineRunResult(detail) };
}

export async function httpResumeTimedOutStage(
  base: string,
  runId: string,
  stageId: string,
): Promise<RetryStageResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/resume`,
    {},
  );
  if (status === 202) {
    const parsed = body as { runId: string; stageId: string; attemptIndex: number };
    return { ok: true, runId: parsed.runId, stageId: parsed.stageId, attemptIndex: parsed.attemptIndex };
  }
  return { ok: false, reason: extractError(body, status), status };
}

export async function httpRecoverManualStageUntilStop(
  base: string,
  runId: string,
  stageId: string,
  guidance?: string,
): Promise<RetryOrchestrationResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/recovery`,
    guidance !== undefined ? { guidance } : {},
  );
  if (status !== 202) {
    return { ok: false, reason: extractError(body, status), status };
  }
  const detail = await pollRunUntilTerminal(base, runId);
  return { ok: true, pipeline: runDetailToPipelineRunResult(detail) };
}

export async function httpStopManualRecovery(
  base: string,
  runId: string,
  stageId: string,
): Promise<StopManualRecoveryResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/recovery/stop`,
    {},
  );
  if (status === 202) return body as Extract<StopManualRecoveryResult, { ok: true }>;
  return { ok: false, reason: extractError(body, status), status };
}

export async function httpAbandonStage(
  base: string,
  runId: string,
  stageId: string,
): Promise<AbandonStageResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/stages/${enc(stageId)}/abandon`,
    {},
  );
  if (status === 202) {
    const parsed = body as { runId: string; stageId: string };
    return { ok: true, runId: parsed.runId, stageId: parsed.stageId };
  }
  return { ok: false, reason: extractError(body, status), status };
}

export function resolveAbsolute(cwd: string, maybeRelative: string): string {
  return path.resolve(cwd, maybeRelative);
}
