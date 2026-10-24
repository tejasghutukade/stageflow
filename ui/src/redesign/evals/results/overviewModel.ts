import type { EvalResultRow, EvalRunDetail } from "../../../api/evalTypes";
import { formatCost, formatDuration, formatMean, formatPercent, formatScore, formatTokens } from "../format";
import { isAgentRun } from "../agentRun";
import { caseRowView, type CaseRowView, type DotKind } from "./casesModel";
import { byGraderRows, type GraderStatView } from "./gradersModel";
import { repeatsOf, thresholdOf, type Tone } from "./headerModel";

export type KpiTile = { id: string; label: string; value: string; sub: string; tone: Tone };

function wholePercent(rate: number): string {
  return String(Math.round(rate * 100));
}

export function kpiTiles(run: EvalRunDetail): KpiTile[] {
  const stats = run.stats;
  if (!stats) return [];
  const repeats = repeatsOf(run);
  const threshold = thresholdOf(run);

  const passParts = [`${stats.results_passed} of ${stats.results_executed} results`];
  if (stats.pass_rate_ci) {
    passParts.push(`95% CI ${wholePercent(stats.pass_rate_ci.low)} to ${wholePercent(stats.pass_rate_ci.high)} (by case)`);
  }
  const agent = isAgentRun(run);
  const passTone: Tone = stats.pass_rate === null ? "muted" : stats.pass_rate >= threshold ? "ok" : "fail";

  const tiles: KpiTile[] = [
    { id: "pass", label: "Pass rate", value: formatPercent(stats.pass_rate), sub: passParts.join(" · "), tone: passTone },
    {
      id: "score",
      label: "Mean score",
      value: formatScore(stats.mean_score),
      sub: stats.score_spread === null ? "" : `±${formatScore(stats.score_spread)} across repeats`,
      tone: "muted",
    },
  ];

  if (repeats > 1 && stats.reliability !== null) {
    const flips = stats.flaky_cases.length;
    const passEvery = Math.round(stats.reliability * stats.cases_counted);
    const parts = [`${passEvery} of ${stats.cases_counted} cases pass every repeat`];
    if (stats.pass_any !== null) parts.push(`pass@${repeats} ${wholePercent(stats.pass_any)}%`);
    parts.push(`${flips} ${flips === 1 ? "case flips" : "cases flip"}`);
    tiles.push({
      id: "reliability",
      label: `Reliability · pass^${repeats}`,
      value: formatPercent(stats.reliability),
      sub: parts.join(" · "),
      tone: "muted",
    });
  }

  if (agent && stats.mean_turns !== null && stats.mean_turns !== undefined) {
    tiles.push({ id: "turns", label: "Turns", value: formatMean(stats.mean_turns), sub: "per conversation", tone: "muted" });
  }
  if (agent && stats.mean_tool_calls !== null && stats.mean_tool_calls !== undefined) {
    tiles.push({ id: "tool_calls", label: "Tool calls", value: formatMean(stats.mean_tool_calls), sub: "per conversation", tone: "muted" });
  }

  tiles.push(
    {
      id: "latency",
      label: "Latency p50",
      value: formatDuration(stats.latency_p50),
      sub: `p95 ${formatDuration(stats.latency_p95)} · slowest ${formatDuration(stats.latency_max)}`,
      tone: "muted",
    },
    {
      id: "cost",
      label: "Cost",
      value: formatCost(stats.cost_total),
      sub: agent
        ? `${formatCost(stats.cost_per_result)} per result · agent and simulator ${formatCost(stats.cost_stage)} · judge ${formatCost(stats.cost_judge)}`
        : `${formatCost(stats.cost_per_result)} per result · judge ${formatCost(stats.cost_judge)}`,
      tone: "muted",
    },
    {
      id: "tokens",
      label: "Tokens",
      value: formatTokens(stats.tokens_in + stats.tokens_out),
      sub: `${formatTokens(stats.tokens_in)} in · ${formatTokens(stats.tokens_out)} out`,
      tone: "muted",
    },
  );
  return tiles;
}

export function byGraderHeader(previousRun: number | null): { columns: string[]; subtitle: string } {
  return {
    columns: ["Grader", "Pass rate", "Mean", "Range", previousRun === null ? "vs previous" : `vs #${previousRun}`],
    subtitle: "Where the misses come from",
  };
}

export function byGraderView(run: EvalRunDetail): GraderStatView[] {
  return byGraderRows(run);
}

export type HistogramBar = { index: number; count: number; heightPercent: number; tone: Tone; label: string };

export type HistogramModel = {
  bars: HistogramBar[];
  thresholdPercent: number;
  thresholdLabel: string;
  totalText: string;
};

export function histogramModel(run: EvalRunDetail): HistogramModel | null {
  const histogram = run.stats?.score_histogram;
  if (!histogram) return null;
  const bins = histogram.bins;
  const max = Math.max(1, ...bins);
  const total = bins.reduce((sum, n) => sum + n, 0);
  const threshold = histogram.threshold;
  const lastBelow = bins.reduce((found, _n, i) => ((i + 1) / bins.length <= threshold + 1e-9 ? i : found), -1);
  const bars = bins.map((count, i) => {
    const upper = (i + 1) / bins.length;
    const tone: Tone = upper > threshold + 1e-9 ? "ok" : i === lastBelow ? "needs" : "fail";
    return {
      index: i,
      count,
      heightPercent: count === 0 ? 0 : Math.max(2, (count / max) * 100),
      tone,
      label: `${(i / bins.length).toFixed(1)} to ${upper.toFixed(1)}: ${count}`,
    };
  });
  return {
    bars,
    thresholdPercent: threshold * 100,
    thresholdLabel: `threshold ${threshold.toFixed(1)}`,
    totalText: `${total} ${total === 1 ? "result" : "results"}`,
  };
}

export function flakyNote(run: EvalRunDetail): { title: string; body: string } | null {
  const ids = run.stats?.flaky_cases ?? [];
  if (ids.length === 0) return null;
  const shown = ids.slice(0, 5);
  const more = ids.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  return {
    title: `${ids.length} ${ids.length === 1 ? "case gave" : "cases gave"} a different verdict on different repeats`,
    body: `Cases ${list} pass on some repeats and fail on others. Treat a single run on these as noise.`,
  };
}

export const FAILURE_TYPES_EMPTY = "Tag failed results in the case drawer to see them grouped here.";
export const FAILURE_TYPES_HINT = "From tags you add when you review a failed result. Fix the biggest group first.";

export type FailureTypeRow = { key: string; tag: string | null; label: string; count: number; fraction: number };

export type FailureTypesModel = {
  failedText: string;
  rows: FailureTypeRow[];
  emptyText: string | null;
};

export function failureTypesModel(run: EvalRunDetail): FailureTypesModel | null {
  const stats = run.stats;
  if (!stats) return null;
  const failed = stats.results_executed - stats.results_passed;
  const entries = Object.entries(stats.failure_types.by_tag).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows: FailureTypeRow[] = entries.map(([tag, count]) => ({
    key: tag,
    tag,
    label: tag,
    count,
    fraction: failed > 0 ? Math.min(1, count / failed) : 0,
  }));
  if (entries.length > 0 || stats.failure_types.untagged > 0) {
    rows.push({
      key: "__untagged",
      tag: null,
      label: "Not reviewed yet",
      count: stats.failure_types.untagged,
      fraction: failed > 0 ? Math.min(1, stats.failure_types.untagged / failed) : 0,
    });
  }
  return {
    failedText: `${failed} failed ${failed === 1 ? "result" : "results"}`,
    rows,
    emptyText: failed === 0 ? "No failed results." : entries.length === 0 ? FAILURE_TYPES_EMPTY : null,
  };
}

export const FAILING_LIMIT = 5;

export type FailingCaseRow = CaseRowView & { flaky: boolean };

export function failingCaseRows(run: EvalRunDetail, rows: EvalResultRow[]): FailingCaseRow[] {
  const stats = run.stats;
  if (!stats) return [];
  const threshold = thresholdOf(run);
  const byId = new Map(rows.map((row) => [row.case_id, row]));
  const flaky = new Set(stats.flaky_cases);
  return stats.failing_cases.slice(0, FAILING_LIMIT).map((failing) => {
    const row = byId.get(failing.case_id);
    if (row) return { ...caseRowView(row, threshold), flaky: flaky.has(failing.case_id) };
    const dots: DotKind[] = failing.passes.map((passed) => (passed ? "passed" : "failed"));
    return {
      caseId: failing.case_id,
      position: "—",
      title: failing.case_id,
      dots,
      scoreText: formatScore(failing.mean_score),
      scoreTone: "muted" as Tone,
      failedGraders: "—",
      timeText: "—",
      costText: "—",
      flaky: flaky.has(failing.case_id),
    };
  });
}

export function failingCardHeader(run: EvalRunDetail): { shownText: string; allText: string } {
  const stats = run.stats;
  const total = stats?.cases_counted ?? 0;
  const shown = Math.min(FAILING_LIMIT, stats?.failing_cases.length ?? 0);
  return { shownText: `${shown} of ${total}`, allText: `All ${total} cases` };
}
