import path from "node:path";
import type { ValidationResult } from "../config/validateCatalog.js";
import { globalStageflowHome } from "../project/globalHome.js";
import type { PipelineRunResult } from "../runtime/pipelineRunner.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import type {
  AbandonStageResult,
  CancelRunResult,
  DecideFeedbackLoopResult,
  DeleteRunResult,
  GcRunsResult,
  StartRunResult,
  StopManualRecoveryResult,
} from "../runtime/runManager.js";
import type { RetentionSweepReport } from "../runtime/runRetentionSweep.js";
import type { DeliverAnswerResult } from "../runtime/stageHitl.js";
import type { RetryStageResult } from "../runtime/runRetryCoordinator.js";
import { resolveStoreRoot, runWorkspaceDir } from "../runstore/paths.js";
import type { RunDetail, RunStore } from "../runstore/port.js";
import { clientAuthorizationHeaders } from "../server/controlToken.js";
import type { TriggerListItem } from "../server/triggerRoutes.js";
import type { TaskFile } from "../types/task.js";

async function postJson(
  base: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...clientAuthorizationHeaders("POST"),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await parseJsonBody(res) };
}

async function getJson(
  base: string,
  urlPath: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${urlPath}`, {
    headers: { ...clientAuthorizationHeaders("GET") },
  });
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
  return runWorkspaceDir(resolveStoreRoot(globalStageflowHome()), runId);
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
    detail.status === "cancelled" ||
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
        : detail.status === "cancelled"
          ? "cancelled"
          : "waiting";
  const reason =
    outcome === "cancelled"
      ? (detail.cancel_reason ?? detail.failed_reason)
      : outcome === "failed"
        ? detail.failed_reason
        : undefined;
  return {
    ok: outcome === "succeeded",
    outcome,
    runId: detail.run_id,
    runDir: computeRunDir(detail.run_id),
    ...(reason !== undefined ? { reason } : {}),
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
  task: string | TaskFile;
  project_root?: string;
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
  const parsed = body as {
    runId: string;
    queued?: boolean;
    queuePosition?: number;
  };
  const runId = parsed.runId;
  return {
    ok: true,
    runId,
    ...(parsed.queued === true
      ? { queued: true, queuePosition: parsed.queuePosition }
      : {}),
    done: pollRunUntilTerminal(base, runId).then(runDetailToPipelineRunResult),
  };
}

export type HttpEnsureProjectResult =
  | { ok: true; project_root: string }
  | Extract<StartRunResult, { ok: false }>;

export async function httpEnsureProject(
  base: string,
  projectRoot: string,
): Promise<HttpEnsureProjectResult> {
  const { status, body } = await postJson(base, "/api/projects", {
    project_root: projectRoot,
  });
  if (status === 200) {
    const parsed = body as { project_root?: unknown };
    if (typeof parsed.project_root === "string" && parsed.project_root.length > 0) {
      return { ok: true, project_root: parsed.project_root };
    }
    return {
      ok: false,
      reason: "ensure_project response missing project_root",
      status,
    };
  }
  return toStartFailure(status, body);
}

export async function httpRerun(
  base: string,
  runId: string,
  options?: { pinned?: boolean },
): Promise<StartRunResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/rerun`,
    options?.pinned !== undefined ? { pinned: options.pinned } : {},
  );
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
  if (status === 202) {
    const verification = (body as { verification?: unknown } | null)?.verification;
    return verification === "failed_retrying"
      ? { ok: true, verification }
      : { ok: true };
  }
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
    const code =
      body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : undefined;
    return {
      ok: false,
      reason: extractError(body, status),
      status,
      ...(code !== undefined ? { code } : {}),
    };
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

export async function httpCancelRun(
  base: string,
  runId: string,
  reason: string,
): Promise<CancelRunResult> {
  const { status, body } = await postJson(
    base,
    `/api/runs/${enc(runId)}/cancel`,
    { reason },
  );
  if (status === 202) {
    const parsed = body as { runId: string };
    return { ok: true, runId: parsed.runId };
  }
  return { ok: false, reason: extractError(body, status), status };
}

export async function httpDeleteRun(
  base: string,
  runId: string,
  options?: { force?: boolean },
): Promise<DeleteRunResult> {
  const forceQs = options?.force ? "?force=true" : "";
  const res = await fetch(`${base}/api/runs/${enc(runId)}${forceQs}`, {
    method: "DELETE",
    headers: { ...clientAuthorizationHeaders("DELETE") },
  });
  const body = await parseJsonBody(res);
  if (res.status === 200) {
    const parsed = body as { runId: string };
    return { ok: true, runId: parsed.runId };
  }
  return {
    ok: false,
    reason: extractError(body, res.status),
    status: res.status,
  };
}

export async function httpGcRuns(
  base: string,
  options?: { execute?: boolean },
): Promise<GcRunsResult> {
  const { status, body } = await postJson(base, "/api/runs/gc", {
    execute: options?.execute === true,
  });
  if (status === 200) {
    const parsed = body as RetentionSweepReport;
    return {
      ok: true,
      slimmed: parsed.slimmed ?? [],
      purged: parsed.purged ?? [],
      bareCachesEvicted: parsed.bareCachesEvicted ?? [],
    };
  }
  return { ok: false, reason: extractError(body, status), status };
}

export type HttpTriggerLookupResult =
  | { ok: true; trigger: TriggerListItem }
  | { ok: false; reason: string; status?: number };

export type HttpListTriggersResult =
  | { ok: true; triggers: TriggerListItem[] }
  | { ok: false; reason: string; status?: number };

export async function httpFireTrigger(
  base: string,
  triggerId: string,
  task?: Record<string, unknown>,
): Promise<StartRunResult> {
  const { status, body } = await postJson(
    base,
    `/api/triggers/${enc(triggerId)}/fire`,
    task !== undefined ? { task } : {},
  );
  if (status !== 202) return toStartFailure(status, body);
  const parsed = body as {
    runId: string;
    queued?: boolean;
    queuePosition?: number;
  };
  const runId = parsed.runId;
  return {
    ok: true,
    runId,
    ...(parsed.queued === true
      ? { queued: true, queuePosition: parsed.queuePosition }
      : {}),
    done: pollRunUntilTerminal(base, runId).then(runDetailToPipelineRunResult),
  };
}

export async function httpListTriggers(
  base: string,
): Promise<HttpListTriggersResult> {
  const { status, body } = await getJson(base, "/api/triggers");
  if (status !== 200) {
    return { ok: false, reason: extractError(body, status), status };
  }
  const parsed = body as { triggers: TriggerListItem[] };
  return { ok: true, triggers: parsed.triggers };
}

export async function httpGetTrigger(
  base: string,
  triggerId: string,
): Promise<HttpTriggerLookupResult> {
  const { status, body } = await getJson(base, `/api/triggers/${enc(triggerId)}`);
  if (status !== 200) {
    return { ok: false, reason: extractError(body, status), status };
  }
  return { ok: true, trigger: body as TriggerListItem };
}

export type HttpEvalResult<T> =
  | { ok: true; body: T }
  | {
      ok: false;
      reason: string;
      status: number;
      code?: string;
      findings?: unknown[];
    };

function evalFailure(status: number, body: unknown): Extract<HttpEvalResult<never>, { ok: false }> {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    reason: extractError(body, status),
    status,
    ...(typeof rec.code === "string" ? { code: rec.code } : {}),
    ...(Array.isArray(rec.findings) ? { findings: rec.findings } : {}),
  };
}

function evalQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${enc(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

async function evalGet<T>(
  base: string,
  urlPath: string,
  expected = 200,
): Promise<HttpEvalResult<T>> {
  const { status, body } = await getJson(base, urlPath);
  return status === expected ? { ok: true, body: body as T } : evalFailure(status, body);
}

export function httpListEvals(base: string, projectRoot?: string) {
  return evalGet<Record<string, unknown>>(base, `/api/evals${evalQuery({ project_root: projectRoot })}`);
}

export function httpGetEval(base: string, evalId: string, projectRoot?: string) {
  return evalGet<Record<string, unknown>>(
    base,
    `/api/evals/${enc(evalId)}${evalQuery({ project_root: projectRoot })}`,
  );
}

export async function httpValidateEval(
  base: string,
  input: { project_root?: string; yaml?: string; path?: string },
): Promise<HttpEvalResult<Record<string, unknown>>> {
  const { status, body } = await postJson(base, "/api/evals/validate", input);
  return status === 200 ? { ok: true, body: body as Record<string, unknown> } : evalFailure(status, body);
}

export type HttpStartEvalRunInput = {
  project_root?: string;
  repeats?: number;
  judge?: string;
  model?: string;
  max_cost_usd?: number;
  case_ids?: string[];
  tags?: string[];
  label?: string;
  started_via?: "console" | "cli" | "mcp";
};

export async function httpStartEvalRun(
  base: string,
  evalId: string,
  input: HttpStartEvalRunInput,
): Promise<HttpEvalResult<{ eval_run_id: string; status: string; run_number?: number }>> {
  const { status, body } = await postJson(base, `/api/evals/${enc(evalId)}/runs`, input);
  return status === 202
    ? { ok: true, body: body as { eval_run_id: string; status: string; run_number?: number } }
    : evalFailure(status, body);
}

export function httpGetEvalRun(base: string, evalRunId: string) {
  return evalGet<Record<string, any>>(base, `/api/eval-runs/${enc(evalRunId)}`);
}

export async function httpCancelEvalRun(
  base: string,
  evalRunId: string,
): Promise<HttpEvalResult<Record<string, any>>> {
  const { status, body } = await postJson(base, `/api/eval-runs/${enc(evalRunId)}/cancel`, {});
  return status === 200 ? { ok: true, body: body as Record<string, any> } : evalFailure(status, body);
}

export function httpListEvalRuns(
  base: string,
  query: { eval_id?: string; project_root?: string; limit?: number; cursor?: string } = {},
) {
  return evalGet<{ items: Array<Record<string, unknown>>; next_cursor: string | null }>(
    base,
    `/api/eval-runs${evalQuery(query)}`,
  );
}

export async function httpDeleteEvalRun(
  base: string,
  evalRunId: string,
): Promise<HttpEvalResult<null>> {
  const res = await fetch(`${base}/api/eval-runs/${enc(evalRunId)}`, {
    method: "DELETE",
    headers: { ...clientAuthorizationHeaders("DELETE") },
  });
  if (res.status === 204) return { ok: true, body: null };
  return evalFailure(res.status, await parseJsonBody(res));
}

export function httpCompareEvalRuns(base: string, a: string, b: string) {
  return evalGet<Record<string, unknown>>(base, `/api/eval-compare${evalQuery({ a, b })}`);
}

export function httpListDatasets(base: string, projectRoot?: string) {
  return evalGet<{ items: Array<Record<string, unknown>> }>(
    base,
    `/api/datasets${evalQuery({ project_root: projectRoot })}`,
  );
}

export function resolveAbsolute(cwd: string, maybeRelative: string): string {
  return path.resolve(cwd, maybeRelative);
}
