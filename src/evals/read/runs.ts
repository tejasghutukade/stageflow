import path from "node:path";
import { loadDatasetFile } from "../../config/loadDataset.js";
import { loadEvalOutcome, resolveEvalPaths } from "../../config/loadEval.js";
import { resolveAgentTarget, type AgentCatalogPort } from "../../config/resolveAgentTarget.js";
import { resolveEvalTarget } from "../../config/resolveEvalTarget.js";
import type { RunStore } from "../../runstore/port.js";
import type { EvalLiveState } from "../manager.js";
import { computeStats, lowestCases, type LowestCase, type Stats } from "../stats.js";
import { toGradeRecords, toResultRecord } from "../statsAdapter.js";
import { resultKey, type GraderRef, type PreviousRunLite } from "../statsTypes.js";
import type {
  EvalGradeRow,
  EvalResultWithGrades,
  EvalReviewRow,
  EvalRunRow,
} from "../storeTypes.js";

export type ReadStore = Pick<
  RunStore,
  | "listEvalRuns"
  | "getEvalRun"
  | "getEvalRunByNumber"
  | "listEvalResults"
  | "getEvalResultsForCase"
  | "getEvalCases"
  | "getEvalReviews"
>;

export type RunHeadline = {
  eval_run_id: string;
  eval_id: string;
  run_number: number;
  status: string;
  passed: boolean | null;
  pass_rate: number | null;
  pass_rate_ci: { low: number; high: number } | null;
  results_executed: number;
  cost_total: number;
  finished_at: string | null;
  fingerprint: string;
  label: string | null;
};

export type WireGrade = {
  grader_id: string;
  grader_type: string;
  status: string;
  passed: boolean | null;
  score: number | null;
  raw_value: number | null;
  reason: string | null;
  details: unknown;
  error_code: string | null;
  judge_model: string | null;
  judge_cost_usd: number | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

export type WireResultDetail = {
  case_id: string;
  repeat_index: number;
  status: string;
  error_code: string | null;
  error_message: string | null;
  stage_run_id: string | null;
  subject_ref: string | null;
  turns: number | null;
  tool_call_count: number | null;
  agent?: { id: string; session_id: string | null } | null;
  output: unknown;
  latency_ms: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  score: number | null;
  passed: boolean;
  grades: WireGrade[];
  budget_warnings: string[];
  review: { label: string | null; note: string | null } | null;
  tags: string[];
};

export type RunCurrent = {
  stage_version_hash: string | null;
  dataset_hash: string | null;
  grader_hashes: Record<string, string> | null;
  agent_revision?: number | null;
  agent_definition_hash?: string | null;
};

export type ConversationView = {
  messages: unknown[];
  tool_calls: unknown[];
  final_reply: string;
  stop_reason: string;
};

export function conversationView(output: unknown): ConversationView | null {
  const rec = asRecord(output);
  if (rec.kind !== "conversation") return null;
  if (!Array.isArray(rec.messages) || !Array.isArray(rec.tool_calls)) return null;
  return {
    messages: rec.messages,
    tool_calls: rec.tool_calls,
    final_reply: typeof rec.final_reply === "string" ? rec.final_reply : "",
    stop_reason: typeof rec.stop_reason === "string" ? rec.stop_reason : "",
  };
}

export type EvalRunDetail = {
  eval_run_id: string;
  run_number: number;
  eval_id: string;
  eval_path: string;
  status: string;
  status_reason: string | null;
  passed: boolean | null;
  label: string | null;
  started_via: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: {
    results_done: number;
    results_total: number;
    cost_usd: number;
    max_cost_usd: number;
    cases_total: number;
  };
  config: Record<string, unknown>;
  fingerprint: string;
  components: Record<string, unknown>;
  stats: Stats | null;
  lowest_cases_by_grader: Record<string, LowestCase[]>;
  current: RunCurrent;
  live?: Array<{ case_id: string; repeat_index: number; phase: string }>;
};

type Summary = {
  pass_rate?: number | null;
  pass_rate_ci?: { low: number; high: number } | null;
  results_executed?: number;
  cost_total?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function runHeadline(row: EvalRunRow): RunHeadline {
  const summary = (row.summary ?? {}) as Summary;
  return {
    eval_run_id: row.evalRunId,
    eval_id: row.evalId,
    run_number: row.runNumber,
    status: row.status,
    passed: row.passed,
    pass_rate: summary.pass_rate ?? null,
    pass_rate_ci: summary.pass_rate_ci ?? null,
    results_executed: summary.results_executed ?? row.resultsDone,
    cost_total: summary.cost_total ?? row.costUsd,
    finished_at: row.finishedAt,
    fingerprint: row.configFingerprint,
    label: row.label,
  };
}

export type ActiveRun = {
  run_number: number;
  eval_run_id: string;
  status: "queued" | "running";
  results_done: number;
  results_total: number;
};

/** The newest queued or running run of an eval, or null. */
export async function activeRunOf(
  store: Pick<ReadStore, "listEvalRuns">,
  projectRoot: string,
  evalId: string,
): Promise<ActiveRun | null> {
  const found: EvalRunRow[] = [];
  for (const status of ["running", "queued"] as const) {
    const page = await store.listEvalRuns({ projectRoot, evalId, status, limit: 50 });
    found.push(...page.items);
  }
  const row = found.sort((a, b) => b.runNumber - a.runNumber)[0];
  if (!row || (row.status !== "queued" && row.status !== "running")) return null;
  return {
    run_number: row.runNumber,
    eval_run_id: row.evalRunId,
    status: row.status,
    results_done: row.resultsDone,
    results_total: row.resultsTotal,
  };
}

export function graderRefsOf(row: Pick<EvalRunRow, "config">): GraderRef[] {
  const graders = asRecord(row.config).graders;
  if (!Array.isArray(graders)) return [];
  return graders.flatMap((g): GraderRef[] => {
    const rec = asRecord(g);
    return typeof rec.id === "string" && typeof rec.hash === "string"
      ? [{ id: rec.id, type: typeof rec.type === "string" ? rec.type : "", hash: rec.hash }]
      : [];
  });
}

export function reviewTagMap(reviews: readonly EvalReviewRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const review of reviews) {
    if (review.tags.length > 0) map.set(resultKey(review.caseId, review.repeatIndex), review.tags);
  }
  return map;
}

export function statsOfRun(
  row: EvalRunRow,
  results: readonly EvalResultWithGrades[],
  extra: { reviews?: readonly EvalReviewRow[]; previousRun?: PreviousRunLite | null } = {},
): Stats {
  return computeStats({
    ...(row.targetKind === "agent" ? { targetKind: "agent" as const } : {}),
    results: results.map(toResultRecord),
    grades: results.flatMap(toGradeRecords),
    graders: graderRefsOf(row),
    repeats: row.repeats,
    passThreshold: row.passThreshold,
    ...(extra.reviews ? { reviewsTags: reviewTagMap(extra.reviews) } : {}),
    ...(extra.previousRun !== undefined ? { previousRun: extra.previousRun } : {}),
  });
}

export async function completedRunsNewestFirst(
  store: Pick<ReadStore, "listEvalRuns">,
  projectRoot: string,
  evalId: string,
  limit = 50,
): Promise<EvalRunRow[]> {
  const page = await store.listEvalRuns({ projectRoot, evalId, status: "completed", limit });
  return [...page.items].sort((a, b) => b.runNumber - a.runNumber);
}

export async function previousRunLite(
  store: ReadStore,
  row: EvalRunRow,
  graders: readonly GraderRef[],
): Promise<PreviousRunLite | null> {
  const earlier = (await completedRunsNewestFirst(store, row.projectRoot, row.evalId)).filter(
    (r) => r.runNumber < row.runNumber,
  );
  if (earlier.length === 0) return null;
  const rates = new Map<string, Map<string, number | null>>();
  const rateOf = async (run: EvalRunRow, graderId: string): Promise<number | null> => {
    let byGrader = rates.get(run.evalRunId);
    if (!byGrader) {
      const stats = statsOfRun(run, await store.listEvalResults(run.evalRunId));
      byGrader = new Map(stats.by_grader.map((g) => [g.grader_id, g.pass_rate]));
      rates.set(run.evalRunId, byGrader);
    }
    return byGrader.get(graderId) ?? null;
  };
  const lite: PreviousRunLite["graders"] = [];
  for (const g of graders) {
    let changedHash: string | undefined;
    let match: EvalRunRow | undefined;
    for (const run of earlier) {
      const found = graderRefsOf(run).find((x) => x.id === g.id);
      if (!found) continue;
      if (found.hash === g.hash) {
        match = run;
        break;
      }
      changedHash ??= found.hash;
    }
    if (match) lite.push({ graderId: g.id, hash: g.hash, passRate: await rateOf(match, g.id) });
    else if (changedHash !== undefined) lite.push({ graderId: g.id, hash: changedHash, passRate: null });
  }
  return { graders: lite };
}

export function gradeToWire(g: EvalGradeRow): WireGrade {
  return {
    grader_id: g.graderId,
    grader_type: g.graderType,
    status: g.status,
    passed: g.passed,
    score: g.score,
    raw_value: g.rawValue,
    reason: g.reason,
    details: g.details,
    error_code: g.errorCode,
    judge_model: g.judgeModel,
    judge_cost_usd: g.judgeCostUsd,
    judge_tokens_in: g.judgeTokensIn,
    judge_tokens_out: g.judgeTokensOut,
  };
}

export function resultToWire(
  r: EvalResultWithGrades,
  review: EvalReviewRow | undefined,
  agentId?: string,
): WireResultDetail {
  const hasReview = review !== undefined && (review.label !== null || review.note !== null);
  return {
    case_id: r.caseId,
    repeat_index: r.repeatIndex,
    status: r.status,
    error_code: r.errorCode,
    error_message: r.errorMessage,
    stage_run_id: r.stageRunId,
    subject_ref: r.subjectRef,
    turns: r.turns,
    tool_call_count: r.toolCallCount,
    ...(agentId !== undefined
      ? { agent: r.subjectRef !== null ? { id: agentId, session_id: r.subjectRef } : null }
      : {}),
    output: r.output,
    latency_ms: r.latencyMs,
    cost_usd: r.costUsd,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    score: r.score,
    passed: r.passed,
    grades: r.grades.map(gradeToWire),
    budget_warnings: r.budgetWarnings ?? [],
    review: hasReview ? { label: review.label, note: review.note } : null,
    tags: review?.tags ?? [],
  };
}

export async function currentHashes(row: EvalRunRow, agents?: AgentCatalogPort): Promise<RunCurrent> {
  const isAgent = row.targetKind === "agent";
  const none: RunCurrent = {
    stage_version_hash: null,
    dataset_hash: null,
    grader_hashes: null,
    ...(isAgent ? { agent_revision: null, agent_definition_hash: null } : {}),
  };
  const evalAbs = path.resolve(row.projectRoot, row.evalPath);
  try {
    const outcome = await loadEvalOutcome(evalAbs, row.projectRoot);
    if (!outcome.ok) return none;
    const loaded = outcome.value;
    const paths = resolveEvalPaths(loaded.file, loaded.path);
    const datasetHashOf = async () => {
      const dataset = await loadDatasetFile(paths.datasetPath, { root: row.projectRoot });
      return dataset.findings.some((f) => f.severity === "error") ? null : dataset.contentHash;
    };
    const graderHashes = Object.fromEntries(loaded.graders.map((g) => [g.id, g.hash]));
    if (isAgent) {
      const resolved = agents ? await resolveAgentTarget(loaded.file, row.projectRoot, agents) : null;
      return {
        stage_version_hash: null,
        dataset_hash: await datasetHashOf(),
        grader_hashes: graderHashes,
        agent_revision: resolved?.ok ? resolved.value.revision : null,
        agent_definition_hash: resolved?.ok ? resolved.value.definitionHash : null,
      };
    }
    const [target, datasetHash] = await Promise.all([
      resolveEvalTarget(loaded.file, loaded.path, row.projectRoot),
      datasetHashOf(),
    ]);
    return {
      stage_version_hash: target.ok ? target.value.stageVersionHash : null,
      dataset_hash: datasetHash,
      grader_hashes: graderHashes,
    };
  } catch {
    return none;
  }
}

export async function buildRunDetail(input: {
  store: ReadStore;
  row: EvalRunRow;
  live?: EvalLiveState | null;
  agents?: AgentCatalogPort;
}): Promise<EvalRunDetail> {
  const { store, row } = input;
  const [results, reviews] = await Promise.all([
    store.listEvalResults(row.evalRunId),
    store.getEvalReviews(row.evalRunId),
  ]);
  const graders = graderRefsOf(row);
  const grades = results.flatMap(toGradeRecords);
  const executed = results.some((r) => ["completed", "stage_failed", "needs_input", "error"].includes(r.status));
  const stats = executed
    ? statsOfRun(row, results, { reviews, previousRun: await previousRunLite(store, row, graders) })
    : null;
  const detail: EvalRunDetail = {
    eval_run_id: row.evalRunId,
    run_number: row.runNumber,
    eval_id: row.evalId,
    eval_path: row.evalPath,
    status: row.status,
    status_reason: row.statusReason,
    passed: row.passed,
    label: row.label,
    started_via: row.startedVia,
    created_at: row.createdAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    progress: {
      results_done: row.resultsDone,
      results_total: row.resultsTotal,
      cost_usd: row.costUsd,
      max_cost_usd: row.maxCostUsd,
      cases_total: row.casesTotal,
    },
    config: row.config,
    fingerprint: row.configFingerprint,
    components: row.configComponents,
    stats,
    lowest_cases_by_grader: executed
      ? Object.fromEntries(
          graders.map((g) => [g.id, lowestCases(grades.filter((x) => x.graderId === g.id))]),
        )
      : {},
    current: await currentHashes(row, input.agents),
  };
  if (input.live && (row.status === "running" || row.status === "queued")) {
    detail.live = input.live.phases.map((p) => ({
      case_id: p.caseId,
      repeat_index: p.repeatIndex,
      phase: p.phase,
    }));
  }
  return detail;
}

export async function buildExport(input: {
  store: ReadStore;
  row: EvalRunRow;
  what: "results" | "config";
}): Promise<{ filename: string; body: unknown }> {
  const { store, row, what } = input;
  const filename = `${row.evalId}-run-${row.runNumber}-${what}.json`;
  if (what === "config") return { filename, body: row.config };
  const [detail, results, reviews] = await Promise.all([
    buildRunDetail({ store, row }),
    store.listEvalResults(row.evalRunId),
    store.getEvalReviews(row.evalRunId),
  ]);
  const reviewByKey = new Map(reviews.map((r) => [resultKey(r.caseId, r.repeatIndex), r]));
  return {
    filename,
    body: {
      ...detail,
      results: results.map((r) => resultToWire(r, reviewByKey.get(resultKey(r.caseId, r.repeatIndex)))),
    },
  };
}
