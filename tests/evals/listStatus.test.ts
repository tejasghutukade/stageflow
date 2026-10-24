import { describe, expect, it } from "vitest";
import { estimateRun } from "../../src/evals/estimate.js";
import { listStatus, regressionBanner, type ListRunSummary } from "../../src/evals/listStatus.js";

const r = (
  runNumber: number,
  passed: boolean,
  passRate: number,
  graders: ListRunSummary["graders"] = [],
  finishedAt = `2026-01-0${runNumber}T00:00:00Z`,
): ListRunSummary => ({ runNumber, passed, passRate, finishedAt, graders });

describe("listStatus", () => {
  it("covers all five statuses", () => {
    expect(listStatus([], "capability")).toBe("never_run");
    expect(listStatus([r(2, true, 0.98)], "capability")).toBe("saturated");
    expect(listStatus([r(2, true, 0.97)], "capability")).toBe("passing");
    expect(listStatus([r(2, true, 1)], "regression")).toBe("passing");
    expect(listStatus([r(2, false, 0.5), r(1, true, 0.9)], "capability")).toBe("regressed");
    expect(listStatus([r(2, false, 0.5), r(1, false, 0.4)], "capability")).toBe("failing");
    expect(listStatus([r(1, false, 0.4)], "regression")).toBe("failing");
  });
});

describe("regressionBanner", () => {
  const g = (graderId: string, hash: string, passRate: number | null) => ({ graderId, hash, passRate });

  it("returns null without regressions", () => {
    expect(regressionBanner([{ evalId: "a", status: "passing", last: r(2, true, 1), previous: r(1, true, 1) }])).toBeNull();
  });

  it("counts dropped criteria on same hash only, threshold -5 points", () => {
    const prev = r(1, true, 0.9, [g("a", "h", 1), g("b", "h", 1), g("c", "h", 1), g("d", "old", 1), g("e", "h", 0.5)]);
    const last = r(2, false, 0.6, [g("a", "h", 0.95), g("b", "h", 0.96), g("c", "h", 0.5), g("d", "new", 0), g("e", "h", null)]);
    const b = regressionBanner([{ evalId: "x", status: "regressed", last, previous: prev }]);
    expect(b).toEqual({
      eval_id: "x",
      previous_pass_rate: 0.9,
      last_pass_rate: 0.6,
      criteria_dropped: 2,
      last_run_number: 2,
      previous_run_number: 1,
    });
  });

  it("picks the eval whose last run finished most recently", () => {
    const mk = (id: string, finished: string) => ({
      evalId: id,
      status: "regressed" as const,
      last: r(2, false, 0.1, [], finished),
      previous: r(1, true, 0.9),
    });
    expect(regressionBanner([mk("old", "2026-01-01T00:00:00Z"), mk("new", "2026-02-01T00:00:00Z")])?.eval_id).toBe("new");
  });
});

describe("estimateRun", () => {
  it("uses the previous run", () => {
    const e = estimateRun({
      resultsTotal: 20,
      rubricGraderCount: 2,
      previous: { runNumber: 3, costStage: 1, costJudge: 0.4, resultsExecuted: 10, rubricGradesGraded: 20, wallSeconds: 50 },
      recentStageCosts: [9],
    });
    expect(e.avg_stage_cost).toBeCloseTo(0.1, 12);
    expect(e.avg_judge_cost).toBeCloseTo(0.02, 12);
    expect(e.stage_calls).toBe(20);
    expect(e.judge_calls).toBe(40);
    expect(e.estimate_usd).toBeCloseTo(2.8, 12);
    expect(e.estimate_seconds).toBe(100);
    expect(e.based_on_run_number).toBe(3);
    expect(e.judge_excluded).toBe(false);
  });

  it("falls back to recent stage costs and excludes judge", () => {
    const e = estimateRun({ resultsTotal: 10, rubricGraderCount: 1, previous: null, recentStageCosts: [0.1, 0.3] });
    expect(e.estimate_usd).toBeCloseTo(2, 12);
    expect(e.judge_excluded).toBe(true);
    expect(e.estimate_seconds).toBeNull();
    expect(e.based_on_run_number).toBeNull();
  });

  it("null estimate with no history", () => {
    const e = estimateRun({ resultsTotal: 10, rubricGraderCount: 0, previous: null, recentStageCosts: [] });
    expect(e.estimate_usd).toBeNull();
    expect(e.judge_excluded).toBe(false);
  });
});
