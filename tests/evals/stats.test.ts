import { describe, expect, it } from "vitest";
import { computeStats, percentile } from "../../src/evals/stats.js";
import { tQuantile } from "../../src/evals/tTable.js";
import { mkGrade, mkResults } from "./helpers.js";

const base = { graders: [], grades: [], passThreshold: 0.8 };

describe("tQuantile", () => {
  it("matches the table", () => {
    expect(tQuantile(1)).toBe(12.706);
    expect(tQuantile(30)).toBe(2.042);
    expect(tQuantile(31)).toBe(1.96);
    expect(() => tQuantile(0)).toThrow();
    expect(() => tQuantile(1.5)).toThrow();
  });
});

describe("percentile (nearest rank)", () => {
  it("handles 1, 2, 5 and 20 values", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2], 0.5)).toBe(1);
    expect(percentile([1, 2], 0.95)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 0.5)).toBe(10);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("computeStats worked examples", () => {
  it("example 1: 10 cases, 1 repeat, 8 passed", () => {
    const results = Array.from({ length: 10 }, (_, i) => mkResults(`c${i}`, [i < 8])).flat();
    const s = computeStats({ ...base, results, repeats: 1 });
    expect(s.pass_rate).toBeCloseTo(0.8, 12);
    expect(s.pass_rate_ci!.low).toBeCloseTo(0.498, 3);
    expect(s.pass_rate_ci!.high).toBe(1);
    expect(s.reliability).toBeNull();
    expect(s.pass_any).toBeNull();
  });

  it("example 2: 4 cases x 2 repeats, pass counts [2,2,1,0]", () => {
    const results = [
      ...mkResults("c1", [true, true]),
      ...mkResults("c2", [true, true]),
      ...mkResults("c3", [true, false]),
      ...mkResults("c4", [false, false]),
    ];
    const s = computeStats({ ...base, results, repeats: 2 });
    expect(s.pass_rate).toBe(0.625);
    expect(s.pass_rate_ci).toEqual({ low: 0, high: 1 });
    expect(s.reliability).toBe(0.5);
    expect(s.pass_any).toBe(0.75);
    expect(s.flaky_cases).toEqual(["c3"]);
    expect(s.failing_cases.map((c) => c.case_id)).toEqual(["c4", "c3"]);
    expect(s.failing_cases[1].passes).toEqual([true, false]);
  });
});

describe("computeStats edge cases", () => {
  it("zero executed results gives null rates without throwing", () => {
    const s = computeStats({
      ...base,
      results: mkResults("a", [false, false], { status: "skipped_budget", score: null }),
      repeats: 2,
    });
    expect(s.results_executed).toBe(0);
    expect(s.pass_rate).toBeNull();
    expect(s.pass_rate_ci).toBeNull();
    expect(s.mean_score).toBeNull();
    expect(s.reliability).toBeNull();
    expect(s.cost_per_result).toBeNull();
    expect(s.latency_p50).toBeNull();
  });

  it("one case has no CI", () => {
    const s = computeStats({ ...base, results: mkResults("a", [true]), repeats: 1 });
    expect(s.pass_rate).toBe(1);
    expect(s.pass_rate_ci).toBeNull();
  });

  it("excludes skipped and cancelled, counts errors as failed", () => {
    const results = [
      ...mkResults("a", [true]),
      ...mkResults("b", [false], { status: "error", score: null }),
      ...mkResults("c", [false], { status: "cancelled", score: null }),
      ...mkResults("d", [false], { status: "skipped_budget", score: null }),
    ];
    const s = computeStats({ ...base, results, repeats: 1 });
    expect(s.results_executed).toBe(2);
    expect(s.errored).toBe(1);
    expect(s.pass_rate).toBe(0.5);
    expect(s.cases_counted).toBe(2);
    expect(s.mean_score).toBe(1);
  });

  it("tolerates missing latency and cost", () => {
    const results = [
      ...mkResults("a", [true], { latencyMs: 100, costUsd: 0.5 }),
      ...mkResults("b", [true]),
    ];
    const s = computeStats({ ...base, results, repeats: 1 });
    expect(s.latency_p50).toBe(100);
    expect(s.latency_max).toBe(100);
    expect(s.cost_stage).toBe(0.5);
    expect(s.cost_per_result).toBe(0.25);
  });

  it("computes score spread, histogram and costs", () => {
    const results = [
      ...mkResults("a", [true, true]).map((r, i) => ({ ...r, score: i === 0 ? 1 : 0.5, costUsd: 1, tokensIn: 10, tokensOut: 5 })),
      ...mkResults("b", [true], { score: 0.8 }),
    ];
    const grades = [mkGrade("a", 0, "g", true, { judgeCostUsd: 0.25, judgeTokensIn: 3 })];
    const s = computeStats({ ...base, results, grades, repeats: 2, graders: [{ id: "g", type: "schema", hash: "h" }] });
    expect(s.score_spread).toBeCloseTo(Math.SQRT1_2 * 0.5, 12);
    expect(s.score_histogram.bins[9]).toBe(1);
    expect(s.score_histogram.bins[5]).toBe(1);
    expect(s.score_histogram.bins[8]).toBe(1);
    expect(s.cost_judge).toBe(0.25);
    expect(s.cost_total).toBe(2.25);
    expect(s.tokens_in).toBe(20);
    expect(s.judge_tokens_in).toBe(3);
  });

  it("by_grader stats and delta only with same hash", () => {
    const results = [...mkResults("a", [true]), ...mkResults("b", [false])];
    const grades = [
      mkGrade("a", 0, "g", true, { rawValue: 4 }),
      mkGrade("b", 0, "g", false, { rawValue: 2 }),
      mkGrade("a", 0, "h", true, { status: "error", passed: null, score: null, rawValue: null }),
    ];
    const graders = [
      { id: "g", type: "rubric", hash: "x" },
      { id: "h", type: "schema", hash: "y" },
    ];
    const same = computeStats({
      ...base,
      results,
      grades,
      graders,
      repeats: 1,
      previousRun: { graders: [{ graderId: "g", hash: "x", passRate: 0.75 }, { graderId: "h", hash: "other", passRate: 1 }] },
    });
    const g = same.by_grader[0];
    expect(g).toMatchObject({ graded: 2, passed: 1, pass_rate: 0.5, mean_raw: 3, min_raw: 2, max_raw: 4, errors: 0 });
    expect(g.delta).toBeCloseTo(-25, 9);
    expect(same.by_grader[1]).toMatchObject({ graded: 0, errors: 1, delta: null, grader_changed: true, pass_rate: null });
  });

  it("failure types count tags once per result and untagged", () => {
    const results = [
      ...mkResults("a", [false]),
      ...mkResults("b", [false]),
      ...mkResults("c", [false]),
      ...mkResults("d", [true]),
    ];
    const tags = new Map([
      ["a:0", ["format", "tone"]],
      ["b:0", ["format"]],
      ["d:0", ["format"]],
    ]);
    const s = computeStats({ ...base, results, repeats: 1, reviewsTags: tags });
    expect(s.failure_types).toEqual({ by_tag: { format: 2, tone: 1 }, untagged: 1 });
  });

  it("orders failing cases by pass rate, mean score, id", () => {
    const results = [
      ...mkResults("z", [false], { score: 0.2 }),
      ...mkResults("b", [false], { score: 0.2 }),
      ...mkResults("a", [false], { score: 0.5 }),
    ];
    const s = computeStats({ ...base, results, repeats: 1 });
    expect(s.failing_cases.map((c) => c.case_id)).toEqual(["b", "z", "a"]);
  });
});
