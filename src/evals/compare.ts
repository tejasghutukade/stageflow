import { buildCaseStats, clusteredCi, computeStats, mean, sampleSd, type Interval, type Stats } from "./stats.js";
import { agentDiff, type AgentDiff } from "./agentDiff.js";
import { stageDiff, type StageDiff } from "./stageDiff.js";
import {
  EVAL_COMPARE_MISMATCH,
  EXECUTED_RESULT_STATUSES,
  resultKey,
  type GradeRecord,
  type GraderRef,
  type ResultRecord,
} from "./statsTypes.js";

export interface CompareRunInput {
  evalId: string;
  runNumber: number;
  datasetHash: string;
  stageVersionHash: string;
  stageDefinition: Record<string, unknown> | null;
  targetKind?: "stage" | "agent";
  agentId?: string | null;
  agentRevision?: number | null;
  agentDefinition?: Record<string, unknown> | null;
  configComponents: Record<string, unknown>;
  results: ResultRecord[];
  grades: GradeRecord[];
  graders: GraderRef[];
  repeats: number;
  passThreshold: number;
}

export type Verdict = "improved" | "regressed" | "no_clear_difference" | "insufficient_data";

export type CaseChange = "improved" | "regressed" | "same";

export interface CaseDetail {
  case_id: string;
  change: CaseChange;
  p_a: number;
  p_b: number;
  d: number;
  passes_a: boolean[];
  passes_b: boolean[];
  mean_score_a: number | null;
  mean_score_b: number | null;
  graders_changed: string[];
}

export interface GraderComparison {
  grader_id: string;
  status: "compared" | "changed" | "added" | "removed";
  pass_rate_a: number | null;
  pass_rate_b: number | null;
  delta: number | null;
}

export interface ComponentDiff {
  key: string;
  status: "same" | "changed";
  a: unknown;
  b: unknown;
}

export type CompareWarningCode =
  | "dataset_differs"
  | "graders_differ"
  | "engine_differs"
  | "few_shared_cases";

export interface CompareWarning {
  code: CompareWarningCode;
  shared_cases?: number;
  cases_a?: number;
  cases_b?: number;
}

export interface NumberDelta {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface CompareResult {
  shared_cases: number;
  cases_a: number;
  cases_b: number;
  mean_difference: number | null;
  ci: Interval | null;
  verdict: Verdict;
  cases: CaseDetail[];
  graders: GraderComparison[];
  deltas: {
    cost_per_result: NumberDelta;
    latency_p50: NumberDelta;
    latency_p95: NumberDelta;
    flaky_cases: NumberDelta;
    mean_score: NumberDelta;
    mean_turns?: NumberDelta;
    mean_tool_calls?: NumberDelta;
  };
  stage_diff: StageDiff | null;
  agent_diff?: AgentDiff | null;
  components: ComponentDiff[];
  same_config: boolean;
  warnings: CompareWarning[];
  sd_d: number | null;
  cases_needed_5pts: number | null;
  stats_a: Stats;
  stats_b: Stats;
}

export class CompareMismatchError extends Error {
  readonly code = EVAL_COMPARE_MISMATCH;
  constructor(a: string, b: string, what = "different evals") {
    super(`Cannot compare runs of ${what} (${a} vs ${b})`);
    this.name = "CompareMismatchError";
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value ?? null;
}

function delta(a: number | null, b: number | null): NumberDelta {
  return { a, b, delta: a !== null && b !== null ? b - a : null };
}

function passRateOver(grades: GradeRecord[], graderId: string, cases: Set<string>): number | null {
  const graded = grades.filter(
    (g) => g.graderId === graderId && g.status === "graded" && cases.has(g.caseId),
  );
  if (graded.length === 0) return null;
  return graded.filter((g) => g.passed === 1).length / graded.length;
}

function passedRepeatsByGrader(
  grades: GradeRecord[],
  executedKeys: Set<string>,
  caseId: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of grades) {
    if (g.caseId !== caseId || !executedKeys.has(resultKey(g.caseId, g.repeatIndex))) continue;
    out.set(g.graderId, (out.get(g.graderId) ?? 0) + (g.passed === 1 ? 1 : 0));
  }
  return out;
}

function executedKeysOf(results: ResultRecord[]): Set<string> {
  return new Set(
    results
      .filter((r) => EXECUTED_RESULT_STATUSES.includes(r.status))
      .map((r) => resultKey(r.caseId, r.repeatIndex)),
  );
}

export function compareRuns(a: CompareRunInput, b: CompareRunInput): CompareResult {
  if (a.evalId !== b.evalId) throw new CompareMismatchError(a.evalId, b.evalId);
  const kindA = a.targetKind ?? "stage";
  const kindB = b.targetKind ?? "stage";
  if (kindA !== kindB || (kindA === "agent" && (a.agentId ?? null) !== (b.agentId ?? null))) {
    throw new CompareMismatchError(a.evalId, b.evalId, "different targets");
  }
  const isAgent = kindA === "agent";

  const statsA = computeStats(a);
  const statsB = computeStats(b);
  const casesA = new Map(buildCaseStats(a.results).map((c) => [c.caseId, c]));
  const casesB = new Map(buildCaseStats(b.results).map((c) => [c.caseId, c]));
  const sharedIds = [...casesA.keys()].filter((id) => casesB.has(id)).sort();
  const m = sharedIds.length;
  const shared = new Set(sharedIds);

  const diffs = sharedIds.map((id) => (casesB.get(id)?.p ?? 0) - (casesA.get(id)?.p ?? 0));
  const dBar = mean(diffs);
  const ci = dBar === null ? null : clusteredCi(dBar, diffs, -1, 1);
  const sdD = sampleSd(diffs);
  const casesNeeded =
    sdD === null ? null : Math.ceil(Math.round((1.96 * sdD / 0.05) ** 2 * 1e9) / 1e9);

  let verdict: Verdict = "no_clear_difference";
  if (m < 5 || ci === null) verdict = "insufficient_data";
  else if (ci.low > 0) verdict = "improved";
  else if (ci.high < 0) verdict = "regressed";

  const keysA = executedKeysOf(a.results);
  const keysB = executedKeysOf(b.results);
  const cases: CaseDetail[] = sharedIds.map((id) => {
    const ca = casesA.get(id)!;
    const cb = casesB.get(id)!;
    const d = cb.p - ca.p;
    const pa = passedRepeatsByGrader(a.grades, keysA, id);
    const pb = passedRepeatsByGrader(b.grades, keysB, id);
    const graderIds = [...new Set([...pa.keys(), ...pb.keys()])].sort();
    return {
      case_id: id,
      change: d > 0 ? "improved" : d < 0 ? "regressed" : "same",
      p_a: ca.p,
      p_b: cb.p,
      d,
      passes_a: ca.flags,
      passes_b: cb.flags,
      mean_score_a: ca.meanScore,
      mean_score_b: cb.meanScore,
      graders_changed: graderIds.filter((g) => (pa.get(g) ?? 0) !== (pb.get(g) ?? 0)),
    };
  });
  const rank: Record<CaseChange, number> = { regressed: 0, improved: 1, same: 2 };
  cases.sort(
    (x, y) =>
      rank[x.change] - rank[y.change] ||
      (x.change === "improved" ? y.d - x.d : x.d - y.d) ||
      (x.case_id < y.case_id ? -1 : x.case_id > y.case_id ? 1 : 0),
  );

  const hashA = new Map(a.graders.map((g) => [g.id, g.hash]));
  const hashB = new Map(b.graders.map((g) => [g.id, g.hash]));
  const graderIds = [...new Set([...hashA.keys(), ...hashB.keys()])];
  const graders: GraderComparison[] = graderIds.map((id) => {
    if (!hashB.has(id)) {
      return { grader_id: id, status: "removed", pass_rate_a: null, pass_rate_b: null, delta: null };
    }
    if (!hashA.has(id)) {
      return { grader_id: id, status: "added", pass_rate_a: null, pass_rate_b: null, delta: null };
    }
    if (hashA.get(id) !== hashB.get(id)) {
      return { grader_id: id, status: "changed", pass_rate_a: null, pass_rate_b: null, delta: null };
    }
    const ra = passRateOver(a.grades, id, shared);
    const rb = passRateOver(b.grades, id, shared);
    return {
      grader_id: id,
      status: "compared",
      pass_rate_a: ra,
      pass_rate_b: rb,
      delta: ra !== null && rb !== null ? (rb - ra) * 100 : null,
    };
  });

  const componentKeys = [
    ...new Set([...Object.keys(a.configComponents), ...Object.keys(b.configComponents)]),
  ];
  const components: ComponentDiff[] = componentKeys.map((key) => ({
    key,
    status: canonical(a.configComponents[key]) === canonical(b.configComponents[key]) ? "same" : "changed",
    a: a.configComponents[key] ?? null,
    b: b.configComponents[key] ?? null,
  }));

  const warnings: CompareWarning[] = [];
  if (a.datasetHash !== b.datasetHash) {
    warnings.push({
      code: "dataset_differs",
      shared_cases: m,
      cases_a: casesA.size,
      cases_b: casesB.size,
    });
  }
  if (graders.some((g) => g.status !== "compared")) warnings.push({ code: "graders_differ" });
  if (components.find((c) => c.key === "engine")?.status === "changed") {
    warnings.push({ code: "engine_differs" });
  }
  if (m < 5) warnings.push({ code: "few_shared_cases", shared_cases: m });

  const stage =
    !isAgent &&
    a.stageVersionHash !== b.stageVersionHash && a.stageDefinition && b.stageDefinition
      ? stageDiff(a.stageDefinition, b.stageDefinition)
      : null;

  return {
    shared_cases: m,
    cases_a: casesA.size,
    cases_b: casesB.size,
    mean_difference: dBar,
    ci,
    verdict,
    cases,
    graders,
    deltas: {
      cost_per_result: delta(statsA.cost_per_result, statsB.cost_per_result),
      latency_p50: delta(statsA.latency_p50, statsB.latency_p50),
      latency_p95: delta(statsA.latency_p95, statsB.latency_p95),
      flaky_cases: delta(statsA.flaky_cases.length, statsB.flaky_cases.length),
      mean_score: delta(statsA.mean_score, statsB.mean_score),
      ...(isAgent
        ? {
            mean_turns: delta(statsA.mean_turns ?? null, statsB.mean_turns ?? null),
            mean_tool_calls: delta(statsA.mean_tool_calls ?? null, statsB.mean_tool_calls ?? null),
          }
        : {}),
    },
    stage_diff: stage,
    ...(isAgent
      ? {
          agent_diff:
            a.stageVersionHash !== b.stageVersionHash && a.agentDefinition && b.agentDefinition
              ? agentDiff(a.agentDefinition, b.agentDefinition, {
                  a: a.agentRevision ?? null,
                  b: b.agentRevision ?? null,
                })
              : null,
        }
      : {}),
    components,
    same_config: components.every((c) => c.status === "same"),
    warnings,
    sd_d: sdD,
    cases_needed_5pts: casesNeeded,
    stats_a: statsA,
    stats_b: statsB,
  };
}
