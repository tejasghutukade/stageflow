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

  it("no scored graders: 1 if must-pass pass, else 0", () => {
    expect(run([g("m", { mustPass: true })], [grade("m", 1, 1)])).toMatchObject({ score: 1, passed: true });
    expect(run([g("m", { mustPass: true })], [grade("m", 0, 0)])).toMatchObject({ score: 0, passed: false });
    expect(run([g("a")], [{ graderId: "a", status: "error", passed: null, score: null }])).toMatchObject({
      score: 1,
      hasGraderErrors: true,
    });
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
