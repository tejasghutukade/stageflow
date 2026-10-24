import type { EvalType } from "./statsTypes.js";

const EPS = 1e-9;
const SATURATED_PASS_RATE = 0.98;
const CRITERIA_DROP_POINTS = -5;

export type ListStatus = "never_run" | "saturated" | "passing" | "regressed" | "failing";

export interface ListRunGrader {
  graderId: string;
  hash: string;
  passRate: number | null;
}

export interface ListRunSummary {
  runNumber: number;
  passed: boolean;
  passRate: number | null;
  finishedAt: string | null;
  graders: ListRunGrader[];
}

export function listStatus(completedRunsNewestFirst: ListRunSummary[], type: EvalType): ListStatus {
  const last = completedRunsNewestFirst[0];
  if (!last) return "never_run";
  const previous = completedRunsNewestFirst[1];
  if (last.passed) {
    if (type === "capability" && (last.passRate ?? 0) + EPS >= SATURATED_PASS_RATE) {
      return "saturated";
    }
    return "passing";
  }
  return previous?.passed ? "regressed" : "failing";
}

export interface BannerEvalInput {
  evalId: string;
  status: ListStatus;
  last: ListRunSummary | null;
  previous: ListRunSummary | null;
}

export interface RegressionBanner {
  eval_id: string;
  previous_pass_rate: number | null;
  last_pass_rate: number | null;
  criteria_dropped: number;
  last_run_number: number;
  previous_run_number: number;
}

export function criteriaDropped(last: ListRunSummary, previous: ListRunSummary): number {
  let dropped = 0;
  for (const g of last.graders) {
    const prev = previous.graders.find((p) => p.graderId === g.graderId);
    if (!prev || prev.hash !== g.hash) continue;
    if (g.passRate === null || prev.passRate === null) continue;
    if ((g.passRate - prev.passRate) * 100 <= CRITERIA_DROP_POINTS + EPS) dropped += 1;
  }
  return dropped;
}

export function regressionBanner(evals: BannerEvalInput[]): RegressionBanner | null {
  let best: BannerEvalInput | null = null;
  for (const e of evals) {
    if (e.status !== "regressed" || !e.last || !e.previous) continue;
    if (!best || (e.last.finishedAt ?? "") > (best.last?.finishedAt ?? "")) best = e;
  }
  if (!best?.last || !best.previous) return null;
  return {
    eval_id: best.evalId,
    previous_pass_rate: best.previous.passRate,
    last_pass_rate: best.last.passRate,
    criteria_dropped: criteriaDropped(best.last, best.previous),
    last_run_number: best.last.runNumber,
    previous_run_number: best.previous.runNumber,
  };
}
