import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";
import type {
  EvalAcceptInput,
  EvalAgentTarget,
  EvalClassifierStatus,
  EvalSortInput,
  EvalSortResult,
  EvalSuggestionStatus,
  EvalSuggestionsResponse,
  EvalCaseOp,
  EvalCaseResults,
  EvalCompareResult,
  EvalCreateDatasetInput,
  EvalDatasetCandidate,
  EvalDatasetDetail,
  EvalDatasetListItem,
  EvalDatasetPreview,
  EvalDatasetPreviewInput,
  EvalDatasetQuery,
  EvalDatasetTarget,
  EvalDefinition,
  EvalDetail,
  EvalEngineStatus,
  EvalListQuery,
  EvalListResponse,
  EvalResultsPage,
  EvalResultsQuery,
  EvalReview,
  EvalReviewInput,
  EvalRunDetail,
  EvalSessionCandidate,
  EvalDraftEstimateInput,
  EvalRunEstimate,
  EvalRunListItem,
  EvalRunListQuery,
  EvalRunOptions,
  EvalStartRunInput,
  EvalStartRunResult,
  EvalTryInput,
  EvalTryResult,
  EvalValidateInput,
  EvalValidateResult,
} from "./evalTypes";
import type { ValidationFinding } from "./types";

export class EvalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly findings?: ValidationFinding[],
    public readonly currentHash?: string,
  ) {
    super(message);
    this.name = "EvalApiError";
  }
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export function evalQueryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

async function evalRequest<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  if (res.status === 204) return undefined as T;
  const parsed = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    code?: string;
    findings?: ValidationFinding[];
    current_hash?: string;
  };
  if (!res.ok) {
    throw new EvalApiError(
      res.status,
      typeof parsed.code === "string" ? parsed.code : `HTTP_${res.status}`,
      parsed.error ?? `Request failed (${res.status})`,
      parsed.findings,
      parsed.current_hash,
    );
  }
  return parsed;
}

const enc = encodeURIComponent;

export function fetchEvals(query: EvalListQuery = {}): Promise<EvalListResponse> {
  return evalRequest(`/api/evals${evalQueryString(query)}`);
}

export function fetchEvalAgentTargets(projectRoot?: string): Promise<{ items: EvalAgentTarget[] }> {
  return evalRequest(`/api/evals/agent-targets${evalQueryString({ project_root: projectRoot })}`);
}

export function fetchEval(id: string, projectRoot?: string): Promise<EvalDetail> {
  return evalRequest(`/api/evals/${enc(id)}${evalQueryString({ project_root: projectRoot })}`);
}

export function validateEval(input: EvalValidateInput): Promise<EvalValidateResult> {
  return evalRequest("/api/evals/validate", { method: "POST", body: input });
}

export function createEval(input: {
  project_root?: string;
  definition: EvalDefinition;
  directory?: string;
}): Promise<EvalDetail> {
  return evalRequest("/api/evals", { method: "POST", body: input });
}

export function updateEval(
  id: string,
  input: { project_root?: string; definition?: EvalDefinition; yaml?: string; base_hash: string },
): Promise<EvalDetail> {
  return evalRequest(`/api/evals/${enc(id)}`, { method: "PUT", body: input });
}

export function installEvalSample(projectRoot?: string, kind?: "stage" | "agent"): Promise<{ eval_id: string }> {
  return evalRequest("/api/evals/sample", {
    method: "POST",
    body: { ...(projectRoot !== undefined ? { project_root: projectRoot } : {}), ...(kind === "agent" ? { kind } : {}) },
  });
}

/** An agent try can take minutes; pass a signal to let the author cancel it. */
export function tryEvalCase(input: EvalTryInput, signal?: AbortSignal): Promise<EvalTryResult> {
  return evalRequest("/api/evals/try", { method: "POST", body: input, ...(signal ? { signal } : {}) });
}

export function fetchEvalFailureTypes(id: string, projectRoot?: string): Promise<{ items: string[] }> {
  return evalRequest(`/api/evals/${enc(id)}/failure-types${evalQueryString({ project_root: projectRoot })}`);
}

export function startEvalRun(id: string, input: EvalStartRunInput = {}): Promise<EvalStartRunResult> {
  return evalRequest(`/api/evals/${enc(id)}/runs`, { method: "POST", body: input });
}

export function fetchEvalRunEstimate(
  id: string,
  options: EvalRunOptions & { project_root?: string } = {},
): Promise<EvalRunEstimate> {
  return evalRequest(`/api/evals/${enc(id)}/runs/estimate${evalQueryString(options)}`);
}

export function fetchEvalDraftEstimate(input: EvalDraftEstimateInput): Promise<EvalRunEstimate> {
  return evalRequest("/api/evals/runs/estimate", { method: "POST", body: input });
}

export function fetchEvalRunByNumber(id: string, runNumber: number, projectRoot?: string): Promise<EvalRunDetail> {
  return evalRequest(`/api/evals/${enc(id)}/runs/${runNumber}${evalQueryString({ project_root: projectRoot })}`);
}

export function fetchEvalRuns(
  query: EvalRunListQuery = {},
): Promise<{ items: EvalRunListItem[]; next_cursor: string | null }> {
  return evalRequest(`/api/eval-runs${evalQueryString(query)}`);
}

export function fetchEvalRun(evalRunId: string): Promise<EvalRunDetail> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}`);
}

export function fetchEvalResults(evalRunId: string, query: EvalResultsQuery = {}): Promise<EvalResultsPage> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/results${evalQueryString(query)}`);
}

export function fetchEvalResultCase(evalRunId: string, caseId: string): Promise<EvalCaseResults> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/results/${enc(caseId)}`);
}

export function putEvalReview(
  evalRunId: string,
  caseId: string,
  repeatIndex: number,
  input: EvalReviewInput,
): Promise<EvalReview> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/results/${enc(caseId)}/${repeatIndex}/review`, {
    method: "PUT",
    body: input,
  });
}

export function cancelEvalRun(evalRunId: string): Promise<EvalRunDetail> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/cancel`, { method: "POST", body: {} });
}

export async function deleteEvalRun(evalRunId: string): Promise<void> {
  await evalRequest(`/api/eval-runs/${enc(evalRunId)}`, { method: "DELETE" });
}

export function fetchEvalCompare(a: string, b: string): Promise<EvalCompareResult> {
  return evalRequest(`/api/eval-compare${evalQueryString({ a, b })}`);
}

export function evalRunExportUrl(evalRunId: string, what: "results" | "config" = "results"): string {
  return `/api/eval-runs/${enc(evalRunId)}/export${evalQueryString({ what })}`;
}

export function fetchEvalEngine(): Promise<EvalEngineStatus> {
  return evalRequest("/api/eval-engine");
}

export function fetchEvalDatasets(projectRoot?: string): Promise<{ items: EvalDatasetListItem[] }> {
  return evalRequest(`/api/datasets${evalQueryString({ project_root: projectRoot })}`);
}

export function fetchEvalDataset(id: string, query: EvalDatasetQuery = {}): Promise<EvalDatasetDetail> {
  return evalRequest(`/api/datasets/${enc(id)}${evalQueryString(query)}`);
}

export function previewEvalDataset(input: EvalDatasetPreviewInput): Promise<EvalDatasetPreview> {
  return evalRequest("/api/datasets/preview", { method: "POST", body: input });
}

export function createEvalDataset(input: EvalCreateDatasetInput): Promise<EvalDatasetDetail> {
  return evalRequest("/api/datasets", { method: "POST", body: input });
}

export function patchEvalDatasetCases(
  id: string,
  input: { project_root?: string; base_hash: string; ops: EvalCaseOp[] },
): Promise<EvalDatasetDetail> {
  return evalRequest(`/api/datasets/${enc(id)}/cases`, { method: "PATCH", body: input });
}

export function convertEvalDataset(
  id: string,
  input: { project_root?: string; base_hash: string },
): Promise<EvalDatasetDetail> {
  return evalRequest(`/api/datasets/${enc(id)}/convert`, { method: "POST", body: input });
}

export function fetchEvalSessionCandidates(
  agentId: string,
  options: { project_root?: string; limit?: number } = {},
): Promise<{ items: EvalSessionCandidate[]; next_cursor: string | null }> {
  return evalRequest(`/api/datasets/candidates${evalQueryString({ agent: agentId, ...options })}`);
}

export function fetchEvalDatasetCandidates(
  target: EvalDatasetTarget,
  options: { project_root?: string; limit?: number } = {},
): Promise<{ items: EvalDatasetCandidate[] }> {
  return evalRequest(`/api/datasets/candidates${evalQueryString({ ...target, ...options })}`);
}

export function sortEvalFailures(evalRunId: string, input: EvalSortInput = {}): Promise<EvalSortResult> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/failures/sort`, { method: "POST", body: input });
}

export function fetchEvalSuggestions(
  evalRunId: string,
  status?: EvalSuggestionStatus,
): Promise<EvalSuggestionsResponse> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/failures/suggestions${evalQueryString({ status })}`);
}

export function acceptEvalSuggestions(
  evalRunId: string,
  input: EvalAcceptInput = {},
): Promise<{ accepted: number; tagged: number }> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/failures/suggestions/accept`, { method: "POST", body: input });
}

export function dismissEvalSuggestions(evalRunId: string, ids: string[]): Promise<{ dismissed: number }> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/failures/suggestions/dismiss`, {
    method: "POST",
    body: { ids },
  });
}

export function fetchEvalClassifierStatus(evalRunId: string): Promise<EvalClassifierStatus> {
  return evalRequest(`/api/eval-runs/${enc(evalRunId)}/failures/status`);
}
