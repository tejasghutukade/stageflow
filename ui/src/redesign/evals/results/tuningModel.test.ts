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

import {
  changeText,
  exampleKind,
  exampleSlots,
  withExamples,
  withReason,
  wordingVerdict,
  type SplitResult,
} from "./tuningModel";

const calib = (split: "dev" | "held_out", kappa: number | null, candidate: boolean, n = 20, warnings: Array<"low_n"> = []): EvalCalibration =>
  ({
    id: "c",
    grader_id: "g",
    grader_hash: "h",
    judge: "j",
    prompt_version: 1,
    split,
    candidate,
    stats: { n, agreement: 0.8, cohen_kappa: kappa, tpr: 1, tnr: 1, confusion: { tp: 1, fp: 0, tn: 1, fn: 0 }, warnings },
    disagreements: [],
    cost_usd: 0,
    created_at: "",
  }) as EvalCalibration;

const pair = (split: "dev" | "held_out", before: number | null, after: number | null, n = 20, warnings: Array<"low_n"> = []): SplitResult => ({
  saved: calib(split, before, false),
  candidate: calib(split, after, true, n, warnings),
});

describe("wordingVerdict", () => {
  it("asks for a tuning-row test first", () => {
    expect(wordingVerdict(null, null)).toMatchObject({ tone: "muted" });
    expect(wordingVerdict(pair("dev", null, 0.8), null).tone).toBe("muted");
  });

  it("is unconvinced by a small or negative tuning gain", () => {
    expect(wordingVerdict(pair("dev", 0.7, 0.72), null)).toMatchObject({ tone: "needs", text: expect.stringContaining("No clear gain") });
  });

  it("wants the fair test before it will say yes", () => {
    expect(wordingVerdict(pair("dev", 0.7, 0.89), null)).toMatchObject({ tone: "needs", text: expect.stringContaining("fair-test rows") });
  });

  it("refuses a wording that got worse on the fair test", () => {
    const v = wordingVerdict(pair("dev", 0.7, 0.89), pair("held_out", 0.53, 0.25));
    expect(v.tone).toBe("fail");
    expect(v.text).toContain("Do not save");
  });

  it("accepts a gain that holds, with a caveat when few labels back it", () => {
    expect(wordingVerdict(pair("dev", 0.7, 0.89), pair("held_out", 0.5, 0.6, 20))).toMatchObject({ tone: "ok", text: expect.stringContaining("Safe to save") });
    const few = wordingVerdict(pair("dev", 0.7, 0.89), pair("held_out", 0.5, 0.55, 8, ["low_n"]));
    expect(few.tone).toBe("ok");
    expect(few.text).toContain("Only 8 fair-test labels");
  });
});

describe("changeText, exampleKind, withExamples and withReason", () => {
  it("writes the change", () => {
    expect(changeText(pair("dev", 0.7, 0.89))).toBe("0.70 to 0.89 (+0.19)");
    expect(changeText(pair("dev", 0.5, 0.25))).toBe("0.50 to 0.25 (-0.25)");
    expect(changeText(pair("dev", null, 0.25))).toBe("n/a to 0.25");
  });

  it("names how the judge was wrong", () => {
    const base = { eval_run_id: "r", case_id: "c1", repeat_index: 0, example: { verdict: "fail" as const, output: "o" } };
    expect(exampleKind({ ...base, judge: "pass" })).toEqual({ title: "You said Fail, the judge said Pass", hint: "The judge was too lenient here." });
    expect(exampleKind({ ...base, judge: "fail", example: { verdict: "pass", output: "o" } }).hint).toBe("The judge was too strict here.");
  });

  const definition = { graders: [{ id: "g", type: "rubric", rubric: "r", examples: [{ verdict: "pass", output: "a" }] }] } as never;

  it("adds as many examples as fit", () => {
    expect(exampleSlots(definition, "g")).toBe(5);
    const next = withExamples(definition, "g", [{ verdict: "fail", output: "b" }, { verdict: "pass", output: "c" }]) as unknown as { graders: Array<{ examples: unknown[] }> };
    expect(next.graders[0]!.examples).toHaveLength(3);
    const many = Array.from({ length: 9 }, (_, i) => ({ verdict: "pass" as const, output: `o${i}` }));
    const capped = withExamples(definition, "g", many) as unknown as { graders: Array<{ examples: unknown[] }> };
    expect(capped.graders[0]!.examples).toHaveLength(6);
    expect(withExamples(definition, "g", [])).toBeNull();
  });

  it("swaps the reason, dropping it when empty", () => {
    expect(withReason({ verdict: "fail", output: "o", reason: "old" }, "  new  ")).toEqual({ verdict: "fail", output: "o", reason: "new" });
    expect(withReason({ verdict: "fail", output: "o", reason: "old" }, " ")).toEqual({ verdict: "fail", output: "o" });
  });
});
