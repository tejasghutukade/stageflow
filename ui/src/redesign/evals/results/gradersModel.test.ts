import { describe, expect, it } from "vitest";
import { fixtureGrade, fixtureResult, fixtureRun } from "./fixtures";
import {
  barTone,
  byGraderRows,
  definitionSummary,
  deltaView,
  graderDefinition,
  graderIdsOf,
  judgedGraderIds,
  graderRows,
  judgeSummary,
  kindLabel,
  lowestCases,
} from "./gradersModel";

describe("gradersModel", () => {
  it("labels kinds and tones", () => {
    expect(kindLabel("rubric")).toBe("Rubric");
    expect(kindLabel("field")).toBe("Check");
    expect(barTone(null, 0.8)).toBe("muted");
    expect(barTone(0.9, 0.8)).toBe("ok");
    expect(barTone(0.6, 0.8)).toBe("needs");
    expect(barTone(0.3, 0.8)).toBe("fail");
  });

  it("formats deltas", () => {
    expect(deltaView({ delta: null, grader_changed: false })).toEqual({ text: "—", tone: "muted" });
    expect(deltaView({ delta: null, grader_changed: true })).toEqual({ text: "grader changed", tone: "muted" });
    expect(deltaView({ delta: 0, grader_changed: false }).text).toBe("±0.0 pts");
    expect(deltaView({ delta: 6.2, grader_changed: false })).toEqual({ text: "+6.2 pts", tone: "ok" });
    expect(deltaView({ delta: -2, grader_changed: false })).toEqual({ text: "−2.0 pts", tone: "fail" });
  });

  it("builds by-grader rows from stats", () => {
    const rows = byGraderRows(fixtureRun());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "output-schema", kind: "Check", passText: "100%", meanText: "1.00", rangeText: "1.0-1.0" });
    expect(rows[1]).toMatchObject({ passText: "76%", barTone: "needs", rangeText: "0.0-1.0" });
    expect(rows[2]).toMatchObject({ kind: "Rubric", meanText: "4.1/5", rangeText: "2-5", errorsText: "1" });
    expect(rows[2]!.delta.text).toBe("grader changed");
  });

  it("returns no rows without stats", () => {
    expect(byGraderRows(fixtureRun({ stats: null }))).toEqual([]);
  });

  it("builds grader tab rows from the snapshot, with zero-stat fallbacks", () => {
    const rows = graderRows(fixtureRun());
    expect(rows.map((r) => r.id)).toEqual([
      "output-schema",
      "findings-cite-lines",
      "finds-expected-issues",
      "no-invented-files",
      "clear-and-actionable",
    ]);
    expect(rows[0]).toMatchObject({ weightText: "must pass", hash: "6b2f10", versionText: null });
    expect(rows[1]).toMatchObject({ passText: "—", weightText: "×1", summary: ["payload.findings[*].line exists"] });
    expect(rows[2]).toMatchObject({ weightText: "×3", description: "Findings mention each expected issue" });
    expect(rows[4]).toMatchObject({ isRubric: true, versionText: "v2" });
  });

  it("summarises definitions per type", () => {
    const run = fixtureRun();
    expect(definitionSummary(graderDefinition(run, "clear-and-actionable"))).toEqual([
      "Acts on each finding.",
      "Scale 1 to 5 · passes at 4",
    ]);
    expect(definitionSummary(graderDefinition(run, "no-invented-files"))).toEqual(["No invented files.", "Scale pass / fail"]);
    expect(definitionSummary(graderDefinition(run, "finds-expected-issues"))[0]).toBe(
      "each_mentioned: payload.findings against expected.findings",
    );
    expect(definitionSummary(graderDefinition(run, "output-schema"))).toEqual(["Output matches the stage's output schema"]);
    expect(definitionSummary({ id: "x", type: "code", code: "a\nb" })).toEqual(["a", "b"]);
    expect(definitionSummary({ id: "x", type: "field", checks: [{ path: "p", op: "equals", value: 1 }] })).toEqual(["p equals 1"]);
    expect(definitionSummary({ id: "x", type: "rubric", rubric: "r", judge: "m/j" })).toContain("Judge m/j");
    expect(definitionSummary(null)).toEqual([]);
    expect(definitionSummary({ id: "x", type: "mystery" })).toEqual([]);
  });

  it("finds the lowest-scoring cases", () => {
    const grade = (score: number | null, status: "graded" | "error" = "graded") =>
      fixtureGrade({ grader_id: "g", score, status, reason: `r${score}` });
    const results = [
      fixtureResult({ case_id: "a", repeat_index: 0, grades: [grade(1)] }),
      fixtureResult({ case_id: "a", repeat_index: 1, grades: [grade(0.5)] }),
      fixtureResult({ case_id: "b", repeat_index: 0, grades: [grade(0.2)] }),
      fixtureResult({ case_id: "c", repeat_index: 0, grades: [grade(null, "error")] }),
      fixtureResult({ case_id: "d", repeat_index: 0, grades: [] }),
    ];
    const lowest = [
      { case_id: "b", mean_score: 0.2, worst_repeat_index: 0 },
      { case_id: "a", mean_score: 0.75, worst_repeat_index: 1 },
    ];
    expect(lowestCases(results, "g", lowest)).toEqual([
      { caseId: "b", repeatIndex: 0, scoreText: "0.20", reason: "r0.2" },
      { caseId: "a", repeatIndex: 1, scoreText: "0.75", reason: "r0.5" },
    ]);
    expect(lowestCases(results, "g")).toEqual([]);
  });

  it("summarises the judge for rubric graders", () => {
    const grade = (cost: number) =>
      fixtureGrade({ grader_id: "r", judge_model: "m/j", judge_cost_usd: cost, judge_tokens_in: 1000, judge_tokens_out: 500 });
    expect(judgeSummary([fixtureResult({ grades: [grade(0.01)] }), fixtureResult({ grades: [grade(0.02)] })], "r")).toEqual({
      model: "m/j",
      tokensText: "3k tokens",
      costText: "$0.03",
    });
    expect(judgeSummary([fixtureResult({ grades: [] })], "r")).toBeNull();
    expect(judgeSummary([fixtureResult({ grades: [fixtureGrade({ grader_id: "r" })] })], "r")).toBeNull();
  });
});

describe("graderIdsOf", () => {
  it("reads the saved definition", () => {
    const run = fixtureRun();
    expect(graderIdsOf(run).length).toBeGreaterThan(0);
  });

  it("falls back to the run's own grader list when the saved definition has none", () => {
    const base = fixtureRun();
    const run = fixtureRun({
      config: {
        ...base.config,
        eval: { ...base.config.eval, definition: { version: 1, id: "x" } },
        graders: [{ id: "a", type: "rubric" }, { id: "b", type: "code" }],
      },
    });
    expect(graderIdsOf(run)).toEqual(["a", "b"]);
  });
});

describe("judgedGraderIds", () => {
  it("lists the graders a model judges, from the run's own grader list", () => {
    const base = fixtureRun();
    const run = fixtureRun({
      config: {
        ...base.config,
        graders: [
          { id: "a", type: "rubric" },
          { id: "b", type: "code" },
          { id: "c", type: "goal_reached" },
        ],
      },
    });
    expect(judgedGraderIds(run)).toEqual(["a", "c"]);
  });

  it("falls back to the saved definition", () => {
    const base = fixtureRun();
    const run = fixtureRun({
      config: {
        ...base.config,
        graders: undefined,
        eval: { ...base.config.eval, definition: { graders: [{ id: "x", type: "rubric" }, { id: "y", type: "field" }] } },
      },
    });
    expect(judgedGraderIds(run)).toEqual(["x"]);
  });
});
