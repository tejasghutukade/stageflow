import { describe, expect, it } from "vitest";
import type { EvalCompareCase, EvalCompareResult, EvalStats } from "../../../api/evalTypes";
import {
  barGeometry,
  buildCaseRows,
  buildGraderRows,
  buildKpiTiles,
  buildStageDiff,
  buildStrip,
  caseCounts,
  ciText,
  configChip,
  defaultSelection,
  footerNote,
  formatSignedPoints,
  pickerOptions,
  stageDiffSummary,
  verdictModel,
  warningText,
} from "./compareModel";

function stats(rate: number): EvalStats {
  return { pass_rate: rate } as EvalStats;
}

function result(overrides: Partial<EvalCompareResult> = {}): EvalCompareResult {
  return {
    shared_cases: 24,
    cases_a: 24,
    cases_b: 24,
    mean_difference: 0.021,
    ci: { low: -0.06, high: 0.1 },
    verdict: "no_clear_difference",
    cases: [],
    graders: [],
    deltas: {
      cost_per_result: { a: 0.58, b: 0.638, delta: 0.058, percent_change: 10 },
      latency_p50: { a: 3600, b: 3900, delta: 300, percent_change: null },
      latency_p95: { a: 1, b: 1, delta: 0, percent_change: null },
      flaky_cases: { a: 5, b: 3, delta: -2, percent_change: null },
      mean_score: { a: 0.83, b: 0.86, delta: 0.03, percent_change: null },
    },
    stage_diff: null,
    components: [
      { key: "stage", status: "changed", a: "8c21de00ff", b: "3f9a1c00aa" },
      { key: "dataset", status: "same", a: "9b41c0aa11", b: "9b41c0aa11" },
      { key: "graders", status: "same", a: { x: "h1", y: "h2" }, b: { x: "h1", y: "h2" } },
      { key: "judge", status: "same", a: "claude-sonnet-4-5", b: "claude-sonnet-4-5" },
      { key: "repeats", status: "same", a: 3, b: 3 },
    ],
    same_config: false,
    warnings: [],
    sd_d: 0.3,
    cases_needed_5pts: 120,
    stats_a: stats(0.854),
    stats_b: stats(0.875),
    ...overrides,
  };
}

describe("pickers", () => {
  it("labels and sorts newest first, merging extras", () => {
    const options = pickerOptions(
      [
        { run_number: 13, pass_rate: 0.854 },
        { run_number: 14, pass_rate: 0.875 },
      ],
      [{ run_number: 9, pass_rate: null }],
    );
    expect(options.map((o) => o.label)).toEqual(["Run #14 · 87.5%", "Run #13 · 85.4%", "Run #9"]);
  });

  it("defaults b to the latest and a to the previous", () => {
    expect(defaultSelection([12, 14, 13], {})).toEqual({ a: 13, b: 14 });
    expect(defaultSelection([14], {})).toBeNull();
    expect(defaultSelection([], { a: 2, b: 5 })).toEqual({ a: 2, b: 5 });
    expect(defaultSelection([12, 13, 14], { b: 13 })).toEqual({ a: 12, b: 13 });
    expect(defaultSelection([12, 13, 14], { a: 14 })).toEqual({ a: 14, b: 13 });
  });
});

describe("kpi tiles", () => {
  it("builds the pass rate tile with points, interval and verdict", () => {
    const [rate] = buildKpiTiles(result());
    expect(rate.value).toBe("85.4% → 87.5%");
    expect(rate.sub).toBe("+2.1 pts · 95% CI −6 to +10 · inconclusive");
    expect(rate.subTone).toBe("muted");
  });

  it("omits the interval when null and keeps the verdict tone", () => {
    const [rate] = buildKpiTiles(result({ ci: null, verdict: "insufficient_data", mean_difference: null }));
    expect(rate.sub).toBe("not enough shared cases");
    const [improved] = buildKpiTiles(result({ verdict: "improved" }));
    expect(improved.subTone).toBe("ok");
    const [worse] = buildKpiTiles(result({ verdict: "regressed", mean_difference: -0.05 }));
    expect(worse.sub).toContain("−5.0 pts");
    expect(worse.subTone).toBe("fail");
  });

  it("builds the other tiles", () => {
    const tiles = buildKpiTiles(result());
    expect(tiles[1].value).toBe("0.83 → 0.86");
    expect(tiles[1].sub).toBe("+0.03");
    expect(tiles[2].value).toBe("5 → 3");
    expect(tiles[2].sub).toBe("−2 · steadier");
    expect(tiles[2].subTone).toBe("ok");
    expect(tiles[3].value).toBe("3.6 s → 3.9 s");
    expect(tiles[3].sub).toBe("+0.3 s");
    expect(tiles[4].value).toBe("$0.58 → $0.64");
    expect(tiles[4].sub).toBe("+10%");
    expect(tiles[4].subTone).toBe("needs");
  });

  it("handles null deltas", () => {
    const nulls = { a: null, b: null, delta: null, percent_change: null };
    const tiles = buildKpiTiles(result({ deltas: { ...result().deltas, cost_per_result: nulls, mean_score: nulls, flaky_cases: nulls, latency_p50: nulls } }));
    expect(tiles[1].sub).toBe("—");
    expect(tiles[4].sub).toBe("—");
    expect(tiles[2].sub).toBe("—");
  });
});

describe("verdict and ci helpers", () => {
  it("maps verdict words and tones", () => {
    expect(verdictModel("improved")).toEqual({ word: "improved", tone: "ok" });
    expect(verdictModel("regressed")).toEqual({ word: "regressed", tone: "fail" });
    expect(verdictModel("no_clear_difference")).toEqual({ word: "inconclusive", tone: "muted" });
    expect(verdictModel("insufficient_data")).toEqual({ word: "not enough shared cases", tone: "muted" });
  });

  it("formats points and intervals", () => {
    expect(formatSignedPoints(0.04)).toBe("0.0 pts");
    expect(formatSignedPoints(-2)).toBe("−2.0 pts");
    expect(ciText({ low: 0.02, high: 0.1 })).toBe("95% CI +2 to +10");
    expect(ciText(null)).toBeNull();
  });
});

describe("strip", () => {
  it("lists held and changed components", () => {
    const strip = buildStrip(result());
    expect(strip.held).toEqual(["dataset 9b41c0", "2 graders", "judge claude-sonnet-4-5", "3 repeats"]);
    expect(strip.changed).toEqual(["stage version 8c21de to 3f9a1c"]);
    expect(strip.amber).toBe(false);
    expect(configChip(result())).toEqual({ text: "Same dataset · same graders · same judge", amber: false });
  });

  it("flags dataset and grader differences in amber with warnings", () => {
    const r = result({
      components: [
        { key: "dataset", status: "changed", a: "aaaaaaaa11", b: "bbbbbbbb22" },
        { key: "graders", status: "changed", a: { x: "h1", y: "h2" }, b: { x: "h1", y: "h9" } },
        { key: "judge", status: "same", a: "j", b: "j" },
      ],
      warnings: [
        { code: "dataset_differs", shared_cases: 20, cases_a: 24, cases_b: 22 },
        { code: "graders_differ" },
      ],
    });
    const strip = buildStrip(r);
    expect(strip.amber).toBe(true);
    expect(strip.changed).toEqual(["dataset aaaaaa to bbbbbb", "graders y"]);
    expect(strip.warnings[0]).toBe("Datasets differ. Only the 20 shared cases are compared (20 of 24 / 22).");
    expect(strip.warnings[1]).toBe("Graders differ; scores are not comparable.");
    expect(configChip(r)).toEqual({ text: "Different dataset · graders", amber: true });
  });

  it("words the other warnings", () => {
    expect(warningText({ code: "engine_differs" })).toMatch(/engine differs/);
    expect(warningText({ code: "judge_differs" })).toMatch(/judge model or judge prompt differs/);
    expect(warningText({ code: "few_shared_cases", shared_cases: 3 })).toBe(
      "Only 3 shared cases; at least 5 are needed for a verdict.",
    );
  });
});

describe("by grader", () => {
  it("builds bars centered and clamped", () => {
    expect(barGeometry(0)).toBeNull();
    expect(barGeometry(0.04)).toBeNull();
    expect(barGeometry(null)).toBeNull();
    expect(barGeometry(5)).toEqual({ side: "right", widthPercent: 25 });
    expect(barGeometry(-2)).toEqual({ side: "left", widthPercent: 10 });
    expect(barGeometry(100)).toEqual({ side: "right", widthPercent: 50 });
    expect(barGeometry(-100)).toEqual({ side: "left", widthPercent: 50 });
  });

  it("builds rows for compared, unchanged and changed graders", () => {
    const rows = buildGraderRows(
      result({
        graders: [
          { grader_id: "a", status: "compared", pass_rate_a: 0.695, pass_rate_b: 0.757, delta: 6.2 },
          { grader_id: "b", status: "compared", pass_rate_a: 1, pass_rate_b: 1, delta: 0 },
          { grader_id: "c", status: "compared", pass_rate_a: 0.94, pass_rate_b: 0.92, delta: -2 },
          { grader_id: "d", status: "changed", pass_rate_a: null, pass_rate_b: null, delta: null },
          { grader_id: "e", status: "added", pass_rate_a: null, pass_rate_b: 0.5, delta: null },
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ aText: "69.5%", bText: "75.7%", deltaText: "+6.2 pts", tone: "ok" });
    expect(rows[1]).toMatchObject({ deltaText: "no change", tone: "muted", bar: null });
    expect(rows[2]).toMatchObject({ deltaText: "−2.0 pts", tone: "fail" });
    expect(rows[3]).toMatchObject({ deltaText: "changed", bar: null });
    expect(rows[4]).toMatchObject({ deltaText: "added" });
  });
});

describe("case tabs", () => {
  const cases: EvalCompareCase[] = [
    { case_id: "c1", change: "regressed", p_a: 1, p_b: 0, d: -1, passes_a: [true], passes_b: [false], mean_score_a: 0.9, mean_score_b: 0.4, graders_changed: ["g1"] },
    { case_id: "c2", change: "improved", p_a: 0, p_b: 1, d: 1, passes_a: [false, false], passes_b: [true, true], mean_score_a: 0.2, mean_score_b: 0.62, graders_changed: [] },
    { case_id: "c3", change: "same", p_a: 1, p_b: 1, d: 0, passes_a: [true], passes_b: [true], mean_score_a: null, mean_score_b: null, graders_changed: [] },
  ];

  it("counts per tab from the payload", () => {
    expect(caseCounts(cases)).toEqual({ fixed: 1, regressed: 1, unchanged: 1 });
  });

  it("builds rows with dots, titles and score change", () => {
    const info = [{ id: "c2", title: "Off-by-one", position: 4 }];
    const [fixed] = buildCaseRows(cases, "fixed", info);
    expect(fixed).toMatchObject({ caseId: "c2", position: 4, title: "Off-by-one", scoreText: "+0.42", scoreTone: "ok" });
    expect(fixed.before).toEqual([false, false]);
    const [regressed] = buildCaseRows(cases, "regressed", null);
    expect(regressed).toMatchObject({ title: "c1", position: null, scoreText: "−0.50", scoreTone: "fail", gradersChanged: ["g1"] });
    expect(buildCaseRows(cases, "unchanged", null)[0].scoreText).toBe("—");
  });
});

describe("stage diff", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ op: (i % 2 ? "add" : "remove") as "add" | "remove", text: `l${i}` }));
  const withDiff = (system_prompt_diff: Array<{ op: "same" | "add" | "remove"; text: string }> | null) =>
    result({ stage_diff: { changed_keys: ["system_prompt"], system_prompt_diff } });

  it("is null when the stage is unchanged", () => {
    expect(buildStageDiff(result(), "review", false)).toBeNull();
  });

  it("collapses to 12 changed lines and expands to everything", () => {
    const all = [...lines, { op: "same" as const, text: "ctx" }];
    const collapsed = buildStageDiff(withDiff(all), "review", false)!;
    expect(collapsed.lines).toHaveLength(12);
    expect(collapsed.canExpand).toBe(true);
    expect(collapsed.title).toBe("What changed in stage review");
    expect(collapsed.hashes).toBe("8c21de → 3f9a1c");
    expect(buildStageDiff(withDiff(all), "review", true)!.lines).toHaveLength(21);
    expect(buildStageDiff(withDiff(lines.slice(0, 3)), "review", false)!.canExpand).toBe(false);
  });

  it("summarizes changed keys", () => {
    expect(stageDiffSummary(["system_prompt"])).toBe("System prompt edited · model, tools and io.output unchanged");
    expect(stageDiffSummary(["model", "io.output"])).toBe("model changed, io.output changed · tools unchanged");
    expect(stageDiffSummary([])).toBe("Stage version changed");
  });
});

describe("footer", () => {
  it("reports m and cases needed", () => {
    expect(footerNote(result())).toBe(
      "Differences are paired by case. A change counts as real only when its 95% interval excludes zero. With 24 cases only large changes show up; about 120 cases are needed to detect 5 points.",
    );
  });

  it("omits the clause when null", () => {
    expect(footerNote(result({ cases_needed_5pts: null }))).toBe(
      "Differences are paired by case. A change counts as real only when its 95% interval excludes zero.",
    );
  });
});
