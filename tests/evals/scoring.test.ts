import { describe, expect, it } from "vitest";
import { graderPassed, normalizeOneToFive, scoreResult, type ScoringGrade, type ScoringGrader } from "../../src/evals/scoring.js";

const g = (id: string, extra: Partial<ScoringGrader> = {}): ScoringGrader => ({
  id,
  weight: 1,
  mustPass: false,
  ...extra,
});
const grade = (graderId: string, score: number, passed: 0 | 1 | null = null, extra: Partial<ScoringGrade> = {}): ScoringGrade => ({
  graderId,
  status: "graded",
  passed,
  score,
  ...extra,
});
const run = (graders: ScoringGrader[], grades: ScoringGrade[], extra = {}) =>
  scoreResult({ graders, grades, passThreshold: 0.8, status: "completed", latencyMs: null, costUsd: null, ...extra });

describe("scoreResult", () => {
  it("all pass", () => {
    expect(run([g("a"), g("b")], [grade("a", 1, 1), grade("b", 1, 1)])).toEqual({
      score: 1,
      passed: true,
      hasGraderErrors: false,
      budgetWarnings: [],
    });
  });

  it("must-pass failure fails the result and is excluded from the mean", () => {
    const r = run([g("m", { mustPass: true, weight: 100 }), g("a")], [grade("m", 0, 0), grade("a", 1, 1)]);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(false);
  });

  it("scored grader error is excluded and flagged", () => {
    const r = run(
      [g("a"), g("b")],
      [grade("a", 1, 1), { graderId: "b", status: "error", passed: null, score: null }],
    );
    expect(r).toMatchObject({ score: 1, passed: true, hasGraderErrors: true });
  });

  it("must-pass grader error fails the result", () => {
    const r = run(
      [g("m", { mustPass: true }), g("a")],
      [{ graderId: "m", status: "error", passed: null, score: null }, grade("a", 1, 1)],
    );
    expect(r.passed).toBe(false);
    expect(r.hasGraderErrors).toBe(true);
  });

  it("must-pass pass with a rubric error and no other grade has a null score and fails", () => {
    // Hand-computed: schema is must_pass (weight 100) and passed, so it is excluded from the mean.
    // The rubric (weight 2) errored and produced no grade. It is the only grader that is not must_pass.
    // weightedSum = 0, weightTotal = 0, so the score is null and the result fails.
    const r = run(
      [g("schema", { mustPass: true, weight: 100 }), g("rubric", { type: "rubric", weight: 2 })],
      [grade("schema", 1, 1), { graderId: "rubric", status: "error", passed: null, score: null }],
    );
    expect(r).toEqual({ score: null, passed: false, hasGraderErrors: true, budgetWarnings: [] });
  });

  it("an errored must-pass grader fails the result even when other graders pass", () => {
    // Hand-computed: schema is must_pass and errored, so it fails the result and is excluded.
    // coverage weight 4 score 1, tone weight 1 score 0.
    // score = (4 * 1 + 1 * 0) / (4 + 1) = 0.8, which meets the 0.8 threshold.
    // passed is still false because the must_pass grader errored.
    const r = run(
      [g("schema", { mustPass: true, weight: 100 }), g("coverage", { weight: 4 }), g("tone", { weight: 1 })],
      [
        { graderId: "schema", status: "error", passed: null, score: null },
        grade("coverage", 1, 1),
        grade("tone", 0, 0),
      ],
    );
    expect(r).toEqual({ score: 0.8, passed: false, hasGraderErrors: true, budgetWarnings: [] });
  });

  it("must-pass pass and rubric pass keep the weighted pass score", () => {
    // Hand-computed: schema is must_pass (weight 100) and passed, so it is excluded.
    // rubric weight 3 score 1, field weight 1 score 0.5.
    // score = (3 * 1 + 1 * 0.5) / (3 + 1) = 3.5 / 4 = 0.875.
    // 0.875 >= 0.8 and no must_pass grader failed, so the result passes.
    const r = run(
      [g("schema", { mustPass: true, weight: 100 }), g("rubric", { type: "rubric", weight: 3 }), g("field", { weight: 1 })],
      [grade("schema", 1, 1), grade("rubric", 1, 1), grade("field", 0.5, 0)],
    );
    expect(r).toEqual({ score: 0.875, passed: true, hasGraderErrors: false, budgetWarnings: [] });
  });

  it("no scored graders: 1 if must-pass pass, else 0", () => {
    expect(run([g("m", { mustPass: true })], [grade("m", 1, 1)])).toMatchObject({ score: 1, passed: true });
    expect(run([g("m", { mustPass: true })], [grade("m", 0, 0)])).toMatchObject({ score: 0, passed: false });
  });

  it("all grader errors leave no score and fail", () => {
    // Hand-computed: weights 3 and 1, both grades error, so both are dropped.
    // weightedSum = 0, weightTotal = 0, and no must_pass grader passed.
    // score = null and passed = false, not the empty-mean default of 1.
    const r = run(
      [g("a", { weight: 3 }), g("b", { weight: 1 })],
      [
        { graderId: "a", status: "error", passed: null, score: null },
        { graderId: "b", status: "error", passed: null, score: null },
      ],
    );
    expect(r).toEqual({ score: null, passed: false, hasGraderErrors: true, budgetWarnings: [] });
  });

  it("weights", () => {
    const r = run([g("a", { weight: 3 }), g("b", { weight: 1 })], [grade("a", 1), grade("b", 0)]);
    expect(r.score).toBe(0.75);
    expect(r.passed).toBe(false);
  });

  it("passes exactly at the threshold", () => {
    const r = run([g("a", { weight: 4 }), g("b", { weight: 1 })], [grade("a", 1), grade("b", 0)]);
    expect(r.score).toBe(0.8);
    expect(r.passed).toBe(true);
  });

  it("budget warnings do not change passed", () => {
    const r = run([g("a")], [grade("a", 1)], { latencyMs: 5000, costUsd: 2, budget: { latencyMs: 1000, costUsd: 1 } });
    expect(r.budgetWarnings).toEqual(["latency", "cost"]);
    expect(r.passed).toBe(true);
    expect(run([g("a")], [grade("a", 1)], { latencyMs: 500, budget: { latencyMs: 1000 } }).budgetWarnings).toEqual([]);
  });

  it("non-completed result has null score", () => {
    const r = run([g("a")], [], { status: "stage_failed" });
    expect(r).toMatchObject({ score: null, passed: false, hasGraderErrors: false });
  });
});

describe("grader pass rules", () => {
  it("normalizes 1_to_5", () => {
    expect(normalizeOneToFive(4)).toBe(0.75);
    expect(normalizeOneToFive(1)).toBe(0);
    expect(normalizeOneToFive(5)).toBe(1);
  });

  it("derives passed from pass_at and threshold when absent", () => {
    const none = { passed: null } as const;
    expect(graderPassed(g("r", { type: "reference", passAt: 0.5 }), { ...none, score: 0.5 }, 0.8)).toBe(true);
    expect(graderPassed(g("r", { type: "reference" }), { ...none, score: 0.9 }, 0.8)).toBe(false);
    const rubric = g("q", { type: "rubric", scale: "1_to_5", passAt: 4 });
    expect(graderPassed(rubric, { ...none, score: 0.75, rawValue: 4 }, 0.8)).toBe(true);
    expect(graderPassed(rubric, { ...none, score: 0.5, rawValue: 3 }, 0.8)).toBe(false);
    expect(graderPassed(g("c", { type: "code" }), { ...none, score: 0.8 }, 0.8)).toBe(true);
    expect(graderPassed(g("c", { type: "code" }), { passed: 1, score: 0.1 }, 0.8)).toBe(true);
  });
});
