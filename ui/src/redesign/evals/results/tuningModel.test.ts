import { describe, expect, it } from "vitest";
import type { EvalCalibration, EvalDefinition } from "../../../api/evalTypes";
import { compareLine, exampleCount, exampleLabel, rubricOf, withExample, withRubric } from "./tuningModel";

const def = (examples?: unknown[]): EvalDefinition =>
  ({
    version: 1,
    id: "e",
    target: { kind: "stage", file: "s.yaml" },
    dataset: "d.jsonl",
    graders: [
      { id: "schema", type: "schema" },
      { id: "clear", type: "rubric", rubric: "Is it clear?", ...(examples ? { examples } : {}) },
    ],
  }) as EvalDefinition;

const cal = (over: Partial<EvalCalibration> & { kappa: number | null }): EvalCalibration => ({
  id: "c",
  grader_id: "clear",
  grader_hash: "h",
  judge: "j",
  prompt_version: 1,
  split: "dev",
  candidate: false,
  stats: { n: 30, agreement: 0.8, cohen_kappa: over.kappa, tpr: 0.8, tnr: 0.8, confusion: { tp: 1, fp: 1, tn: 1, fn: 1 }, warnings: [] },
  disagreements: [],
  cost_usd: 0,
  created_at: "",
  ...over,
});

describe("rubric edits", () => {
  it("appends an example to the rubric only, up to six", () => {
    const one = withExample(def(), "clear", { verdict: "fail", output: "bad" });
    expect(exampleCount(one, "clear")).toBe(1);
    expect(one!.graders[0]).toEqual({ id: "schema", type: "schema" });
    const full = def(Array.from({ length: 6 }, () => ({ verdict: "pass", output: "x" })));
    expect(withExample(full, "clear", { verdict: "pass", output: "y" })).toBeNull();
    expect(withExample(def(), "schema", { verdict: "pass", output: "y" })).toBeNull();
  });

  it("replaces the rubric text and reports no change when equal", () => {
    expect(rubricOf(withRubric(def(), "clear", "Stricter"), "clear")).toBe("Stricter");
    expect(withRubric(def(), "clear", "Is it clear?")).toBeNull();
    expect(rubricOf(null, "clear")).toBe("");
  });
});

describe("compareLine", () => {
  it("shows the change for the same split", () => {
    expect(compareLine(cal({ kappa: 0.4 }), cal({ kappa: 0.62, candidate: true }))).toBe(
      "Candidate on dev labels: kappa 0.62 (was 0.40, +0.22)",
    );
    expect(compareLine(cal({ kappa: 0.6 }), cal({ kappa: 0.5 }))).toBe("Saved rubric on dev labels: kappa 0.50 (was 0.60, -0.10)");
  });

  it("does not compare different splits or missing kappas", () => {
    expect(compareLine(cal({ kappa: 0.4, split: "all" }), cal({ kappa: 0.5 }))).toBe("Saved rubric on dev labels: kappa 0.50");
    expect(compareLine(null, cal({ kappa: 0.5, split: "held_out" }))).toBe("Saved rubric on held-out labels: kappa 0.50");
    expect(compareLine(cal({ kappa: null }), cal({ kappa: 0.5 }))).toBe("Saved rubric on dev labels: kappa 0.50 (was n/a)");
  });
});

describe("exampleLabel", () => {
  it("names the case, your verdict and the judge's", () => {
    expect(
      exampleLabel({ eval_run_id: "r", case_id: "c2", repeat_index: 1, judge: "pass", example: { verdict: "fail", output: "o" } }),
    ).toBe("c2#1: you fail, judge pass");
    expect(
      exampleLabel({ eval_run_id: "r", case_id: "c2", repeat_index: 0, judge: "fail", example: { score: 5, output: "o" } }),
    ).toBe("c2#0: you pass, judge fail");
  });
});
