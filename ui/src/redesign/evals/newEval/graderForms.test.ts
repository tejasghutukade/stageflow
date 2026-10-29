import { describe, expect, it } from "vitest";
import {
  addCheck,
  judgeCallsPerGrade,
  judgeSettingsOf,
  setJudgeSetting,
  addExample,
  newGrader,
  nextGraderId,
  removeCheck,
  removeExample,
  rowToCheck,
  scaleOf,
  scoredWeight,
  setJudge,
  setPassAt,
  setScale,
  showPassAt,
  withCommon,
  footerText,
  parseWeight,
  validateGraderId,
  graderProblems,
  checkToRow,
} from "./graderForms";

describe("grader factories", () => {
  it("numbers ids and keeps them unique", () => {
    expect(nextGraderId([])).toBe("grader-1");
    expect(nextGraderId(["grader-1", "x"])).toBe("grader-3");
    expect(nextGraderId(["grader-2"])).toBe("grader-3");
  });
  it("builds each type with its required keys", () => {
    expect(newGrader("schema", [])).toEqual({ id: "grader-1", type: "schema", must_pass: true });
    expect(newGrader("rubric", ["grader-1"])).toEqual({ id: "grader-2", type: "rubric", rubric: "", scale: "pass_fail" });
    expect(newGrader("reference", []).mode).toBe("each_mentioned");
    expect(newGrader("code", []).code).toBeTypeOf("string");
    expect(newGrader("field", []).checks).toHaveLength(1);
  });
});

describe("common keys", () => {
  it("omits defaults and keeps schema key order", () => {
    const g = withCommon({ id: "a", type: "rubric", rubric: "r", scale: "pass_fail" }, { description: "d", weight: 2, mustPass: true });
    expect(Object.keys(g)).toEqual(["id", "type", "description", "weight", "must_pass", "rubric", "scale"]);
    const plain = withCommon(g, { description: "", weight: 1, mustPass: false });
    expect(Object.keys(plain)).toEqual(["id", "type", "rubric", "scale"]);
  });
  it("parses weight", () => {
    expect(parseWeight("")).toEqual({ ok: true, value: null });
    expect(parseWeight("2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseWeight("0").ok).toBe(false);
  });
  it("excludes must-pass graders from the scored weight", () => {
    const gs = [
      { id: "a", type: "schema", must_pass: true },
      { id: "b", type: "field", weight: 3 },
      { id: "c", type: "code" },
    ];
    expect(scoredWeight(gs)).toBe(4);
    expect(footerText(gs, 0.8)).toBe("3 graders · scored graders add up to a weight of 4 · a run passes at 80% or higher.");
  });
  it("validates ids", () => {
    expect(validateGraderId("ok-1", [])).toBeNull();
    expect(validateGraderId("Bad", [])).not.toBeNull();
    expect(validateGraderId("a", ["a"])).not.toBeNull();
  });
});

describe("field checks", () => {
  it("converts rows to checks by operator", () => {
    expect(rowToCheck({ path: "payload.x", op: "exists", valueText: "ignored" })).toEqual({ ok: true, check: { path: "payload.x", op: "exists" } });
    expect(rowToCheck({ path: "p", op: "gte", valueText: "3" })).toEqual({ ok: true, check: { path: "p", op: "gte", value: 3 } });
    expect(rowToCheck({ path: "p", op: "gte", valueText: "x" }).ok).toBe(false);
    expect(rowToCheck({ path: "p", op: "between", valueText: "[1, 5]" })).toEqual({ ok: true, check: { path: "p", op: "between", value: [1, 5] } });
    expect(rowToCheck({ path: "p", op: "between", valueText: "[5, 1]" }).ok).toBe(false);
    expect(rowToCheck({ path: "p", op: "in", valueText: '["a","b"]' })).toEqual({ ok: true, check: { path: "p", op: "in", value: ["a", "b"] } });
    expect(rowToCheck({ path: "p", op: "equals", valueText: "high" })).toEqual({ ok: true, check: { path: "p", op: "equals", value: "high" } });
    expect(rowToCheck({ path: "p", op: "equals", valueText: "true" })).toEqual({ ok: true, check: { path: "p", op: "equals", value: true } });
    expect(rowToCheck({ path: "p", op: "matches", valueText: "(" }).ok).toBe(false);
    expect(rowToCheck({ path: "p", op: "length_gte", valueText: "1.5" }).ok).toBe(false);
    expect(rowToCheck({ path: " ", op: "exists", valueText: "" }).ok).toBe(false);
  });
  it("round-trips rows", () => {
    expect(checkToRow({ path: "p", op: "in", value: ["a"] })).toEqual({ path: "p", op: "in", valueText: '["a"]' });
    expect(checkToRow({ path: "p", op: "equals", value: "s" }).valueText).toBe("s");
  });
  it("adds and removes checks", () => {
    const g = addCheck(newGrader("field", []));
    expect(g.checks).toHaveLength(2);
    expect(removeCheck(g, 0).checks).toHaveLength(1);
  });
});

describe("rubric", () => {
  it("couples pass_at to the 1_to_5 scale", () => {
    let g = newGrader("rubric", []);
    expect(showPassAt(g)).toBe(false);
    expect(setPassAt(g, 3)).toBe(g);
    g = setScale(g, "1_to_5");
    expect(scaleOf(g)).toBe("1_to_5");
    expect(g.pass_at).toBe(4);
    expect(setPassAt(g, 9).pass_at).toBe(5);
    g = setScale(g, "pass_fail");
    expect("pass_at" in g).toBe(false);
  });
  it("converts examples when the scale changes", () => {
    let g = addExample(newGrader("rubric", []), "pass");
    g = addExample(g, "fail");
    const scored = setScale(g, "1_to_5");
    expect(scored.examples).toEqual([
      { score: 5, output: "" },
      { score: 1, output: "" },
    ]);
    const back = setScale(scored, "pass_fail");
    expect(back.examples).toEqual([
      { verdict: "pass", output: "" },
      { verdict: "fail", output: "" },
    ]);
  });
  it("caps examples at 6 and drops the key when empty", () => {
    let g = newGrader("rubric", []);
    for (let i = 0; i < 8; i += 1) g = addExample(g);
    expect((g.examples as unknown[]).length).toBe(6);
    for (let i = 0; i < 6; i += 1) g = removeExample(g, 0);
    expect("examples" in g).toBe(false);
  });
  it("sets and clears the judge", () => {
    const g = setJudge(newGrader("rubric", []), "a/b");
    expect(g.judge).toBe("a/b");
    expect("judge" in setJudge(g, "")).toBe(false);
  });
  it("reports problems", () => {
    expect(graderProblems(newGrader("rubric", []))).toContain("Describe what the judge looks for");
    expect(graderProblems({ ...newGrader("rubric", []), rubric: "ok" })).toEqual([]);
  });
});

describe("judge settings", () => {
  const base = { id: "r", type: "rubric", rubric: "x" } as any;

  it("sets a setting and removes the whole key when none are left", () => {
    const withVotes = setJudgeSetting(base, "votes", 3);
    expect(withVotes.judge_settings).toEqual({ votes: 3 });
    const both = setJudgeSetting(withVotes, "reasoning", true);
    expect(judgeSettingsOf(both)).toEqual({ votes: 3, reasoning: true });
    const back = setJudgeSetting(setJudgeSetting(both, "votes", 1), "reasoning", false);
    expect("judge_settings" in back).toBe(false);
  });

  it("clears temperature with undefined and counts judge calls", () => {
    const t = setJudgeSetting(base, "temperature", 0);
    expect(judgeSettingsOf(t)).toEqual({ temperature: 0 });
    expect("judge_settings" in setJudgeSetting(t, "temperature", undefined)).toBe(false);
    expect(judgeCallsPerGrade(base)).toBe(1);
    expect(judgeCallsPerGrade(setJudgeSetting(base, "votes", 5))).toBe(5);
  });

  it("ignores a malformed judge_settings value", () => {
    expect(judgeSettingsOf({ ...base, judge_settings: [1] })).toEqual({});
  });
});
