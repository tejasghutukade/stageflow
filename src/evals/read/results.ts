import { mean, percentile } from "../stats.js";
import { EXECUTED_RESULT_STATUSES, resultKey } from "../statsTypes.js";
import type { EvalCaseRow, EvalResultWithGrades, EvalReviewRow } from "../storeTypes.js";

export const RESULT_ROW_STATUSES = ["passed", "failed", "errored", "flaky"] as const;
export type ResultRowStatus = (typeof RESULT_ROW_STATUSES)[number];

export type ResultRow = {
  case_id: string;
  position: number;
  title: string | null;
  tags: string[];
  repeats: Array<{ repeat_index: number; status: string; passed: boolean; score: number | null }>;
  pass_fraction: number | null;
  mean_score: number | null;
  failed_graders: string[];
  latency_ms_p50: number | null;
  cost_usd: number;
  failure_tags: string[];
};

export type ResultRowFilter = {
  status?: ResultRowStatus;
  grader?: string;
  q?: string;
  tag?: string;
};

export type ResultRowCounts = {
  all: number;
  passed: number;
  failed: number;
  errored: number;
  flaky: number;
};

type RowFacts = { row: ResultRow; executed: number; passed: number; errored: boolean; haystack: string };

function caseField<T>(c: EvalCaseRow | undefined, key: string): T | undefined {
  return c ? ((c.case as Record<string, unknown>)[key] as T | undefined) : undefined;
}

function buildFacts(
  caseRow: EvalCaseRow | undefined,
  caseId: string,
  results: readonly EvalResultWithGrades[],
  reviews: Map<string, EvalReviewRow>,
): RowFacts {
  const sorted = [...results].sort((a, b) => a.repeatIndex - b.repeatIndex);
  const executedResults = sorted.filter((r) => EXECUTED_RESULT_STATUSES.includes(r.status));
  const completed = executedResults.filter((r) => r.status === "completed");
  const failedGraders = new Set<string>();
  const failureTags = new Set<string>();
  let cost = 0;
  for (const r of sorted) {
    cost += r.costUsd ?? 0;
    for (const g of r.grades) cost += g.judgeCostUsd ?? 0;
    for (const tag of reviews.get(resultKey(caseId, r.repeatIndex))?.tags ?? []) failureTags.add(tag);
  }
  for (const r of executedResults) {
    for (const g of r.grades) {
      if (g.status === "error" || g.passed === false) failedGraders.add(g.graderId);
    }
  }
  const passed = executedResults.filter((r) => r.passed).length;
  const latencies = completed
    .map((r) => r.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const title = caseField<string>(caseRow, "title");
  const tags = caseField<string[]>(caseRow, "tags") ?? [];
  return {
    executed: executedResults.length,
    passed,
    errored: executedResults.some((r) => r.status !== "completed"),
    haystack: [caseId, title ?? "", JSON.stringify(caseField(caseRow, "input") ?? {})].join("\n").toLowerCase(),
    row: {
      case_id: caseId,
      position: caseRow?.position ?? 0,
      title: title ?? null,
      tags,
      repeats: sorted.map((r) => ({
        repeat_index: r.repeatIndex,
        status: r.status,
        passed: r.passed,
        score: r.score,
      })),
      pass_fraction: executedResults.length > 0 ? passed / executedResults.length : null,
      mean_score: mean(completed.filter((r) => r.score !== null).map((r) => r.score as number)),
      failed_graders: [...failedGraders].sort(),
      latency_ms_p50: percentile(latencies, 0.5),
      cost_usd: cost,
      failure_tags: [...failureTags].sort(),
    },
  };
}

function matchesStatus(f: RowFacts, status: ResultRowStatus): boolean {
  if (status === "errored") return f.errored;
  if (f.executed === 0) return false;
  if (status === "passed") return f.passed === f.executed;
  if (status === "failed") return f.passed < f.executed;
  return f.passed > 0 && f.passed < f.executed && f.executed >= 2;
}

export function buildResultRows(input: {
  cases: readonly EvalCaseRow[];
  results: readonly EvalResultWithGrades[];
  reviews: readonly EvalReviewRow[];
  filter?: ResultRowFilter;
}): { rows: ResultRow[]; counts: ResultRowCounts } {
  const { filter = {} } = input;
  const reviews = new Map(input.reviews.map((r) => [resultKey(r.caseId, r.repeatIndex), r]));
  const byCase = new Map<string, EvalResultWithGrades[]>();
  for (const r of input.results) {
    const list = byCase.get(r.caseId);
    if (list) list.push(r);
    else byCase.set(r.caseId, [r]);
  }
  const caseById = new Map(input.cases.map((c) => [c.caseId, c]));
  const ordered = [...byCase.keys()].sort(
    (a, b) => (caseById.get(a)?.position ?? 0) - (caseById.get(b)?.position ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const q = filter.q?.trim().toLowerCase();
  const facts = ordered
    .map((id) => buildFacts(caseById.get(id), id, byCase.get(id) ?? [], reviews))
    .filter((f) => {
      if (filter.grader !== undefined && !f.row.failed_graders.includes(filter.grader)) return false;
      if (filter.tag !== undefined && !f.row.failure_tags.includes(filter.tag) && !f.row.tags.includes(filter.tag)) {
        return false;
      }
      return q === undefined || q === "" || f.haystack.includes(q);
    });
  const counts: ResultRowCounts = {
    all: facts.length,
    passed: facts.filter((f) => matchesStatus(f, "passed")).length,
    failed: facts.filter((f) => matchesStatus(f, "failed")).length,
    errored: facts.filter((f) => matchesStatus(f, "errored")).length,
    flaky: facts.filter((f) => matchesStatus(f, "flaky")).length,
  };
  const selected = filter.status === undefined ? facts : facts.filter((f) => matchesStatus(f, filter.status!));
  return { rows: selected.map((f) => f.row), counts };
}
