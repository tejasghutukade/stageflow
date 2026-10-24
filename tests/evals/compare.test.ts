import { describe, expect, it } from "vitest";
import { compareRuns, type CompareRunInput } from "../../src/evals/compare.js";
import { lineDiff } from "../../src/evals/lineDiff.js";
import { stageDiff } from "../../src/evals/stageDiff.js";
import { mkGrade, mkResults } from "./helpers.js";

function run(passesByCase: Record<string, boolean[]>, extra: Partial<CompareRunInput> = {}): CompareRunInput {
  return {
    evalId: "e",
    runNumber: 1,
    datasetHash: "d",
    stageVersionHash: "s",
    stageDefinition: null,
    configComponents: { stage: "s", engine: { name: "pf" } },
    results: Object.entries(passesByCase).flatMap(([id, p]) => mkResults(id, p)),
    grades: [],
    graders: [],
    repeats: 1,
    passThreshold: 0.8,
    ...extra,
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
const all = (n: number, v: boolean) => Object.fromEntries(ids(n).map((id) => [id, [v]]));

describe("compareRuns", () => {
  it("identical runs: d = 0, no clear difference", () => {
    const r = compareRuns(run(all(6, true)), run(all(6, true)));
    expect(r.mean_difference).toBe(0);
    expect(r.verdict).toBe("no_clear_difference");
    expect(r.same_config).toBe(true);
    expect(r.cases.every((c) => c.change === "same")).toBe(true);
  });

  it("insufficient data below 5 shared cases", () => {
    const r = compareRuns(run(all(4, false)), run(all(4, true)));
    expect(r.verdict).toBe("insufficient_data");
    expect(r.warnings.map((w) => w.code)).toContain("few_shared_cases");
  });

  it("clear improvement over >= 5 cases", () => {
    const r = compareRuns(run(all(6, false)), run(all(6, true)));
    expect(r.mean_difference).toBe(1);
    expect(r.verdict).toBe("improved");
  });

  it("clear regression", () => {
    expect(compareRuns(run(all(6, true)), run(all(6, false))).verdict).toBe("regressed");
  });

  it("paired CI hand check: diffs [1,0,0,0,0]", () => {
    const a = run({ c0: [false], c1: [true], c2: [true], c3: [false], c4: [false] });
    const b = run({ c0: [true], c1: [true], c2: [true], c3: [false], c4: [false] });
    const r = compareRuns(a, b);
    expect(r.mean_difference).toBeCloseTo(0.2, 12);
    const se = Math.sqrt(0.8 / 20);
    expect(r.ci!.low).toBeCloseTo(0.2 - 2.776 * se, 9);
    expect(r.ci!.high).toBeCloseTo(0.2 + 2.776 * se, 9);
    expect(r.verdict).toBe("no_clear_difference");
    expect(r.sd_d).toBeCloseTo(Math.sqrt(0.2), 12);
    expect(r.cases_needed_5pts).toBe(308);
    expect(r.cases[0]).toMatchObject({ case_id: "c0", change: "improved", d: 1 });
  });

  it("different datasets use only shared cases and warn", () => {
    const a = run({ ...all(5, true), only_a: [false] }, { datasetHash: "d1" });
    const b = run({ ...all(5, true), only_b: [false] }, { datasetHash: "d2" });
    const r = compareRuns(a, b);
    expect(r.shared_cases).toBe(5);
    expect(r.warnings.find((w) => w.code === "dataset_differs")).toMatchObject({ shared_cases: 5, cases_a: 6, cases_b: 6 });
  });

  it("lists regressed cases first with graders_changed", () => {
    const gA = [mkGrade("c0", 0, "g", true), mkGrade("c1", 0, "g", true)];
    const gB = [mkGrade("c0", 0, "g", true), mkGrade("c1", 0, "g", false)];
    const g = [{ id: "g", type: "schema", hash: "h" }];
    const a = run({ c0: [true], c1: [true], c2: [false] }, { grades: gA, graders: g });
    const b = run({ c0: [true], c1: [false], c2: [true] }, { grades: gB, graders: g });
    const r = compareRuns(a, b);
    expect(r.cases.map((c) => c.case_id)).toEqual(["c1", "c2", "c0"]);
    expect(r.cases[0].graders_changed).toEqual(["g"]);
    expect(r.cases[2].graders_changed).toEqual([]);
    expect(r.graders[0]).toMatchObject({ status: "compared", pass_rate_a: 1, pass_rate_b: 0.5, delta: -50 });
  });

  it("changed grader hash has no delta and warns", () => {
    const a = run(all(5, true), { graders: [{ id: "g", type: "rubric", hash: "1" }], grades: [mkGrade("c0", 0, "g", true)] });
    const b = run(all(5, true), { graders: [{ id: "g", type: "rubric", hash: "2" }], grades: [mkGrade("c0", 0, "g", false)] });
    const r = compareRuns(a, b);
    expect(r.graders[0]).toMatchObject({ status: "changed", delta: null });
    expect(r.warnings.map((w) => w.code)).toContain("graders_differ");
  });

  it("deltas, components and stage diff", () => {
    const a = run(all(5, true), {
      stageVersionHash: "s1",
      stageDefinition: { system_prompt: "x", model: "m" },
      configComponents: { stage: "s1", engine: { name: "pf", v: 1 } },
    });
    const b = run(all(5, true), {
      stageVersionHash: "s2",
      stageDefinition: { system_prompt: "y", model: "m" },
      configComponents: { stage: "s2", engine: { name: "pf", v: 2 } },
    });
    const r = compareRuns(a, b);
    expect(r.stage_diff?.changed_keys).toEqual(["system_prompt"]);
    expect(r.components.map((c) => [c.key, c.status])).toEqual([["stage", "changed"], ["engine", "changed"]]);
    expect(r.warnings.map((w) => w.code)).toContain("engine_differs");
    expect(r.deltas.flaky_cases).toEqual({ a: 0, b: 0, delta: 0, percent_change: null });
    expect(r.deltas.latency_p50.delta).toBeNull();
    expect(compareRuns(run(all(5, true)), run(all(5, true))).stage_diff).toBeNull();
  });

  it("rejects runs of different evals", () => {
    expect(() => compareRuns(run(all(5, true)), run(all(5, true), { evalId: "other" }))).toThrow(/different evals/);
  });
});

describe("lineDiff", () => {
  it("identical", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { op: "same", text: "a" },
      { op: "same", text: "b" },
    ]);
  });
  it("pure add and remove", () => {
    expect(lineDiff("a", "a\nb")).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "b" },
    ]);
    expect(lineDiff("a\nb", "a")).toEqual([
      { op: "same", text: "a" },
      { op: "remove", text: "b" },
    ]);
  });
  it("replace", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "remove", text: "b" },
      { op: "add", text: "x" },
      { op: "same", text: "c" },
    ]);
  });
  it("empty strings", () => {
    expect(lineDiff("", "")).toEqual([]);
    expect(lineDiff("", "a")).toEqual([{ op: "add", text: "a" }]);
    expect(lineDiff("a", "")).toEqual([{ op: "remove", text: "a" }]);
  });
  it("trailing newline difference is visible", () => {
    expect(lineDiff("a\n", "a")).toEqual([
      { op: "same", text: "a" },
      { op: "remove", text: "" },
    ]);
    expect(lineDiff("a", "a\n")).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "" },
    ]);
  });
});

describe("stageDiff", () => {
  it("reports system_prompt and io.output separately", () => {
    const a = { system_prompt: "one\ntwo", model: "m", io: { input: { a: 1 }, output: { b: 1 } } };
    const b = { system_prompt: "one\nthree", model: "m", io: { input: { a: 1 }, output: { b: 2 } } };
    const d = stageDiff(a, b);
    expect(d.changed_keys).toEqual(["io.output", "system_prompt"]);
    expect(d.system_prompt_diff).toEqual([
      { op: "same", text: "one" },
      { op: "remove", text: "two" },
      { op: "add", text: "three" },
    ]);
  });
  it("ignores key order and returns null prompt diff when prompt same", () => {
    const d = stageDiff({ io: { output: { x: 1, y: 2 } }, system_prompt: "s" }, { system_prompt: "s", io: { output: { y: 2, x: 1 } } });
    expect(d).toEqual({ changed_keys: [], system_prompt_diff: null });
  });
  it("handles added keys and io input", () => {
    const d = stageDiff({ io: { input: 1 } }, { io: { input: 2 }, model: "m" });
    expect(d.changed_keys).toEqual(["io.input", "model"]);
  });
});

describe("percent_change", () => {
  it("is (b - a) / a * 100, null when a is 0 or a side is missing", () => {
    const withCost = (costs: number[]) =>
      run({}, { results: mkResults("c", [true, true]).map((r, i) => ({ ...r, costUsd: costs[i] ?? 0 })) });
    expect(compareRuns(withCost([1, 1]), withCost([1.25, 1.25])).deltas.cost_per_result.percent_change).toBeCloseTo(25, 9);
    expect(compareRuns(withCost([1, 1]), withCost([0.5, 0.5])).deltas.cost_per_result.percent_change).toBeCloseTo(-50, 9);
    expect(compareRuns(withCost([0, 0]), withCost([1, 1])).deltas.cost_per_result.percent_change).toBeNull();
  });
});
