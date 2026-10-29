import { tQuantile } from "./tTable.js";
import {
  EXECUTED_RESULT_STATUSES,
  resultKey,
  type GradeRecord,
  type GraderRef,
  type PreviousRunLite,
  type ResultRecord,
} from "./statsTypes.js";

export interface ComputeStatsInput {
  results: ResultRecord[];
  grades: GradeRecord[];
  graders: GraderRef[];
  repeats: number;
  passThreshold: number;
  reviewsTags?: Map<string, string[]>;
  previousRun?: PreviousRunLite | null;
  targetKind?: "stage" | "agent";
}

export interface CaseStat {
  caseId: string;
  executed: number;
  passed: number;
  p: number;
  flags: boolean[];
  meanScore: number | null;
}

export interface Interval {
  low: number;
  high: number;
}

export const LOWEST_CASES_LIMIT = 5;

export interface LowestCase {
  case_id: string;
  mean_score: number;
  worst_repeat_index: number;
}

export interface GraderStat {
  grader_id: string;
  type: string;
  hash: string;
  graded: number;
  passed: number;
  pass_rate: number | null;
  mean_raw: number | null;
  min_raw: number | null;
  max_raw: number | null;
  errors: number;
  delta: number | null;
  grader_changed: boolean;
}

export interface FailingCase {
  case_id: string;
  pass_rate: number;
  mean_score: number | null;
  passes: boolean[];
}

export interface Stats {
  cases_counted: number;
  results_executed: number;
  results_passed: number;
  errored: number;
  pass_rate: number | null;
  pass_rate_ci: Interval | null;
  mean_score: number | null;
  score_spread: number | null;
  reliability: number | null;
  pass_any: number | null;
  flaky_cases: string[];
  latency_p50: number | null;
  latency_p95: number | null;
  latency_max: number | null;
  cost_stage: number;
  cost_judge: number;
  cost_total: number;
  cost_per_result: number | null;
  tokens_in: number;
  tokens_out: number;
  judge_tokens_in: number;
  judge_tokens_out: number;
  by_grader: GraderStat[];
  score_histogram: { bins: number[]; threshold: number };
  failure_types: { by_tag: Record<string, number>; untagged: number };
  failing_cases: FailingCase[];
  mean_turns?: number | null;
  mean_tool_calls?: number | null;
}

const EPS = 1e-9;

export function isExecuted(result: ResultRecord): boolean {
  return EXECUTED_RESULT_STATUSES.includes(result.status);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, b) => a + (b - m) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function passFraction(passed: number, executed: number): number | null {
  return executed > 0 ? passed / executed : null;
}

export function lowestCases(grades: GradeRecord[], limit: number = LOWEST_CASES_LIMIT): LowestCase[] {
  const byCase = new Map<string, Array<{ repeat: number; score: number }>>();
  for (const g of grades) {
    if (g.status !== "graded" || g.score === null) continue;
    const list = byCase.get(g.caseId);
    if (list) list.push({ repeat: g.repeatIndex, score: g.score });
    else byCase.set(g.caseId, [{ repeat: g.repeatIndex, score: g.score }]);
  }
  const rows = [...byCase.entries()].map(([caseId, list]) => {
    const worst = [...list].sort((a, b) => a.score - b.score || a.repeat - b.repeat)[0]!;
    return {
      case_id: caseId,
      mean_score: mean(list.map((item) => item.score)) as number,
      worst_repeat_index: worst.repeat,
    };
  });
  rows.sort((a, b) => a.mean_score - b.mean_score || (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0));
  return rows.slice(0, limit);
}

export function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(Math.round(q * sorted.length * 1e9) / 1e9);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function clusteredCi(
  center: number,
  perCase: number[],
  lo: number,
  hi: number,
): Interval | null {
  const n = perCase.length;
  if (n < 2) return null;
  const pBar = perCase.reduce((a, b) => a + b, 0) / n;
  const ss = perCase.reduce((a, b) => a + (b - pBar) ** 2, 0);
  const se = Math.sqrt(ss / (n * (n - 1)));
  const half = tQuantile(n - 1) * se;
  return { low: Math.max(lo, center - half), high: Math.min(hi, center + half) };
}

export function buildCaseStats(results: ResultRecord[]): CaseStat[] {
  const byCase = new Map<string, ResultRecord[]>();
  for (const r of results) {
    if (!isExecuted(r)) continue;
    const list = byCase.get(r.caseId);
    if (list) list.push(r);
    else byCase.set(r.caseId, [r]);
  }
  const out: CaseStat[] = [];
  for (const [caseId, list] of byCase) {
    list.sort((a, b) => a.repeatIndex - b.repeatIndex);
    const passed = list.filter((r) => r.passed === 1).length;
    const scores = list
      .filter((r) => r.status === "completed" && r.score !== null)
      .map((r) => r.score as number);
    out.push({
      caseId,
      executed: list.length,
      passed,
      p: passFraction(passed, list.length) as number,
      flags: list.map((r) => r.passed === 1),
      meanScore: mean(scores),
    });
  }
  return out;
}

function sum(values: Array<number | null>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

export function computeByGrader(
  graders: GraderRef[],
  grades: GradeRecord[],
  previousRun: PreviousRunLite | null | undefined,
): GraderStat[] {
  return graders.map((g) => {
    const own = grades.filter((x) => x.graderId === g.id);
    const graded = own.filter((x) => x.status === "graded");
    const passed = graded.filter((x) => x.passed === 1).length;
    const raws = graded.map((x) => x.rawValue).filter((v): v is number => v !== null);
    const passRate = graded.length > 0 ? passed / graded.length : null;
    const prev = previousRun?.graders.find((p) => p.graderId === g.id);
    const sameHash = prev !== undefined && prev.hash === g.hash;
    const delta =
      sameHash && passRate !== null && prev.passRate !== null
        ? (passRate - prev.passRate) * 100
        : null;
    return {
      grader_id: g.id,
      type: g.type,
      hash: g.hash,
      graded: graded.length,
      passed,
      pass_rate: passRate,
      mean_raw: mean(raws),
      min_raw: raws.length > 0 ? Math.min(...raws) : null,
      max_raw: raws.length > 0 ? Math.max(...raws) : null,
      errors: own.length - graded.length,
      delta,
      grader_changed: prev !== undefined && !sameHash,
    };
  });
}

export function computeStats(input: ComputeStatsInput): Stats {
  const executed = input.results.filter(isExecuted);
  const executedKeys = new Set(executed.map((r) => resultKey(r.caseId, r.repeatIndex)));
  const grades = input.grades.filter((g) => executedKeys.has(resultKey(g.caseId, g.repeatIndex)));
  const cases = buildCaseStats(executed);
  const completed = executed.filter((r) => r.status === "completed");

  const resultsExecuted = executed.length;
  const resultsPassed = executed.filter((r) => r.passed === 1).length;
  const passRate = resultsExecuted > 0 ? resultsPassed / resultsExecuted : null;
  const passRateCi =
    passRate === null
      ? null
      : clusteredCi(
          passRate,
          cases.map((c) => c.p),
          0,
          1,
        );

  const scores = completed.filter((r) => r.score !== null).map((r) => r.score as number);

  const spreads: number[] = [];
  for (const c of cases) {
    const caseScores = completed
      .filter((r) => r.caseId === c.caseId && r.score !== null)
      .map((r) => r.score as number);
    const sd = sampleSd(caseScores);
    if (sd !== null) spreads.push(sd);
  }

  const repeatedCases = cases.filter((c) => c.executed >= 2);
  const reliability =
    input.repeats > 1 && repeatedCases.length > 0
      ? repeatedCases.filter((c) => c.passed === c.executed).length / repeatedCases.length
      : null;
  const passAny =
    input.repeats > 1 && repeatedCases.length > 0
      ? repeatedCases.filter((c) => c.passed >= 1).length / repeatedCases.length
      : null;
  const flaky = repeatedCases.filter((c) => c.passed > 0 && c.passed < c.executed).map((c) => c.caseId);

  const latencies = completed
    .map((r) => r.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const costStage = sum(executed.map((r) => r.costUsd));
  const costJudge = sum(grades.map((g) => g.judgeCostUsd));
  const costTotal = costStage + costJudge;

  const bins = new Array<number>(10).fill(0);
  for (const s of scores) {
    const idx = Math.min(9, Math.max(0, Math.floor(s * 10 + EPS)));
    bins[idx] += 1;
  }

  const byTag: Record<string, number> = {};
  let untagged = 0;
  for (const r of executed) {
    if (r.passed === 1) continue;
    const tags = [...new Set(input.reviewsTags?.get(resultKey(r.caseId, r.repeatIndex)) ?? [])];
    if (tags.length === 0) untagged += 1;
    for (const tag of tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
  }

  const failing = cases
    .filter((c) => c.passed < c.executed)
    .sort(
      (a, b) =>
        a.p - b.p ||
        (a.meanScore ?? 0) - (b.meanScore ?? 0) ||
        (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
    )
    .map((c) => ({
      case_id: c.caseId,
      pass_rate: c.p,
      mean_score: c.meanScore,
      passes: c.flags,
    }));

  const turnValues = executed.flatMap((r) => (r.turns != null ? [r.turns] : []));
  const toolCallValues = executed.flatMap((r) => (r.toolCalls != null ? [r.toolCalls] : []));
  const hasAgentData =
    input.targetKind === "agent" || input.results.some((r) => r.turns != null || r.toolCalls != null);

  return {
    cases_counted: cases.length,
    results_executed: resultsExecuted,
    results_passed: resultsPassed,
    errored: executed.filter((r) => r.status === "error").length,
    pass_rate: passRate,
    pass_rate_ci: passRateCi,
    mean_score: mean(scores),
    score_spread: mean(spreads),
    reliability,
    pass_any: passAny,
    flaky_cases: flaky,
    latency_p50: percentile(latencies, 0.5),
    latency_p95: percentile(latencies, 0.95),
    latency_max: latencies.length > 0 ? latencies[latencies.length - 1] : null,
    cost_stage: costStage,
    cost_judge: costJudge,
    cost_total: costTotal,
    cost_per_result: resultsExecuted > 0 ? costTotal / resultsExecuted : null,
    tokens_in: sum(executed.map((r) => r.tokensIn)),
    tokens_out: sum(executed.map((r) => r.tokensOut)),
    judge_tokens_in: sum(grades.map((g) => g.judgeTokensIn)),
    judge_tokens_out: sum(grades.map((g) => g.judgeTokensOut)),
    by_grader: computeByGrader(input.graders, grades, input.previousRun),
    score_histogram: { bins, threshold: input.passThreshold },
    failure_types: { by_tag: byTag, untagged },
    failing_cases: failing,
    ...(hasAgentData ? { mean_turns: mean(turnValues), mean_tool_calls: mean(toolCallValues) } : {}),
  };
}

export const CALIBRATION_MIN_LABELS = 20;
export const CALIBRATION_MINORITY_SHARE = 0.2;

export interface CalibrationSample {
  caseId: string;
  repeatIndex: number;
  label: boolean;
  judge: boolean;
}

export interface CalibrationStats {
  n: number;
  agreement: number | null;
  cohen_kappa: number | null;
  tpr: number | null;
  tnr: number | null;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  warnings: Array<"low_n" | "imbalanced" | "no_variance">;
}

/** Judge pass is the positive class; the human label is the truth. */
export function computeCalibration(samples: CalibrationSample[]): CalibrationStats {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const s of samples) {
    if (s.judge && s.label) tp++;
    else if (s.judge && !s.label) fp++;
    else if (!s.judge && !s.label) tn++;
    else fn++;
  }
  const n = tp + fp + tn + fn;
  const warnings: CalibrationStats["warnings"] = [];
  if (n < CALIBRATION_MIN_LABELS) warnings.push("low_n");
  const labelPass = tp + fn;
  const labelFail = fp + tn;
  if (n > 0 && Math.min(labelPass, labelFail) / n < CALIBRATION_MINORITY_SHARE) warnings.push("imbalanced");
  const agreement = n > 0 ? (tp + tn) / n : null;
  const judgePass = tp + fp;
  const judgeFail = fn + tn;
  const expected = n > 0 ? (judgePass * labelPass + judgeFail * labelFail) / (n * n) : 0;
  let kappa: number | null = null;
  if (n > 0 && agreement !== null) {
    if (expected >= 1) warnings.push("no_variance");
    else kappa = (agreement - expected) / (1 - expected);
  }
  return {
    n,
    agreement,
    cohen_kappa: kappa,
    tpr: labelPass > 0 ? tp / labelPass : null,
    tnr: labelFail > 0 ? tn / labelFail : null,
    confusion: { tp, fp, tn, fn },
    warnings,
  };
}

/** A strict majority of valid votes passes; a tie fails. */
export function majorityPasses(passes: number, valid: number): boolean {
  return passes * 2 > valid;
}

export function meanOf(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0) / values.length;
}

/** Deterministic 70/30 split by a stable hash of the case id, so every repeat of a case lands on the same side. */
export function calibrationSplitOf(caseId: string): "dev" | "held_out" {
  let h = 2166136261;
  for (let i = 0; i < caseId.length; i++) {
    h ^= caseId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 10 < 7 ? "dev" : "held_out";
}

export interface StabilityStats {
  /** Judge calls per output. */
  k: number;
  /** Outputs with at least two valid votes. */
  n: number;
  /** Outputs whose valid votes were not all the same verdict. */
  unstable: number;
  flip_rate: number | null;
}

/** How often the judge changes its mind on the same output: the share of outputs with a split vote. */
export function computeStability(voteSets: boolean[][], k: number): StabilityStats {
  const counted = voteSets.filter((votes) => votes.length >= 2);
  const unstable = counted.filter((votes) => votes.some((v) => v !== votes[0])).length;
  return { k, n: counted.length, unstable, flip_rate: counted.length > 0 ? unstable / counted.length : null };
}
