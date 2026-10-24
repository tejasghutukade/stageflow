import { describe, expect, it } from "vitest";
import { fixtureRow, fixtureRun, fixtureStats } from "./fixtures";
import {
  byGraderHeader,
  failingCardHeader,
  failingCaseRows,
  failureTypesModel,
  flakyNote,
  histogramModel,
  kpiTiles,
} from "./overviewModel";

describe("overviewModel kpiTiles", () => {
  it("derives the six tiles from stats and config", () => {
    const tiles = kpiTiles(fixtureRun());
    expect(tiles.map((t) => t.id)).toEqual(["pass", "score", "reliability", "latency", "cost", "tokens"]);
    expect(tiles[0]).toMatchObject({
      label: "Pass rate",
      value: "87.5%",
      sub: "63 of 72 results · 95% CI 77 to 97 (by case)",
      tone: "ok",
    });
    expect(tiles[1]).toMatchObject({ value: "0.86", sub: "±0.07 across repeats" });
    expect(tiles[2]).toMatchObject({
      label: "Reliability · pass^3",
      value: "79.0%",
      sub: "19 of 24 cases pass every repeat · pass@3 92% · 3 cases flip",
    });
    expect(tiles[3]).toMatchObject({ value: "3.9 s", sub: "p95 7.8 s · slowest 11.2 s" });
    expect(tiles[4]).toMatchObject({ value: "$0.64", sub: "$0.01 per result · judge $0.11" });
    expect(tiles[5]).toMatchObject({ value: "142k", sub: "118k in · 24k out" });
  });

  it("hides reliability when repeats is 1", () => {
    const run = fixtureRun();
    run.config.settings.repeats = 1;
    run.stats!.reliability = null;
    expect(kpiTiles(run).map((t) => t.id)).not.toContain("reliability");
  });

  it("omits the CI and spread when null, and flags a failing pass rate", () => {
    const run = fixtureRun({ stats: fixtureStats({ pass_rate_ci: null, score_spread: null, pass_rate: 0.5 }) });
    const tiles = kpiTiles(run);
    expect(tiles[0]!.sub).toBe("63 of 72 results");
    expect(tiles[0]!.tone).toBe("fail");
    expect(tiles[1]!.sub).toBe("");
  });

  it("singular flip wording and no pass@k when null", () => {
    const run = fixtureRun({ stats: fixtureStats({ flaky_cases: ["c1"], pass_any: null }) });
    expect(kpiTiles(run)[2]!.sub).toBe("19 of 24 cases pass every repeat · 1 case flips");
  });

  it("returns nothing without stats", () => {
    expect(kpiTiles(fixtureRun({ stats: null }))).toEqual([]);
    expect(histogramModel(fixtureRun({ stats: null }))).toBeNull();
    expect(failureTypesModel(fixtureRun({ stats: null }))).toBeNull();
    expect(failingCaseRows(fixtureRun({ stats: null }), [])).toEqual([]);
  });
});

describe("overviewModel by-grader header", () => {
  it("names the previous run", () => {
    expect(byGraderHeader(13).columns[4]).toBe("vs #13");
    expect(byGraderHeader(null).columns[4]).toBe("vs previous");
  });
});

describe("overviewModel histogram", () => {
  it("colours bars against the threshold", () => {
    const model = histogramModel(fixtureRun())!;
    expect(model.totalText).toBe("72 results");
    expect(model.thresholdPercent).toBe(80);
    expect(model.thresholdLabel).toBe("threshold 0.8");
    expect(model.bars.map((b) => b.tone)).toEqual([
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
      "needs",
      "ok",
      "ok",
    ]);
    expect(model.bars[9]!.heightPercent).toBe(100);
    expect(model.bars[0]!.heightPercent).toBe(0);
    expect(model.bars[2]!.heightPercent).toBeGreaterThanOrEqual(2);
  });

  it("handles an empty histogram", () => {
    const run = fixtureRun({
      stats: fixtureStats({ score_histogram: { bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], threshold: 0.8 } }),
    });
    expect(histogramModel(run)!.totalText).toBe("0 results");
  });
});

describe("overviewModel flaky note", () => {
  it("lists the flaky cases", () => {
    expect(flakyNote(fixtureRun())).toEqual({
      title: "3 cases gave a different verdict on different repeats",
      body: "Cases c003, c007, c021 pass on some repeats and fail on others. Treat a single run on these as noise.",
    });
  });

  it("truncates long lists, singular, and hides when none", () => {
    const many = fixtureRun({ stats: fixtureStats({ flaky_cases: ["a", "b", "c", "d", "e", "f", "g"] }) });
    expect(flakyNote(many)!.body).toContain("a, b, c, d, e and 2 more");
    const one = fixtureRun({ stats: fixtureStats({ flaky_cases: ["a"] }) });
    expect(flakyNote(one)!.title).toBe("1 case gave a different verdict on different repeats");
    expect(flakyNote(fixtureRun({ stats: fixtureStats({ flaky_cases: [] }) }))).toBeNull();
    expect(flakyNote(fixtureRun({ stats: null }))).toBeNull();
  });
});

describe("overviewModel failure types", () => {
  it("sorts tags by count and adds the not-reviewed row", () => {
    const model = failureTypesModel(fixtureRun())!;
    expect(model.failedText).toBe("9 failed results");
    expect(model.rows.map((r) => [r.label, r.count, r.tag])).toEqual([
      ["Missed an expected issue", 5, "Missed an expected issue"],
      ["Too vague", 2, "Too vague"],
      ["Not reviewed yet", 2, null],
    ]);
    expect(model.rows[0]!.fraction).toBeCloseTo(5 / 9);
    expect(model.emptyText).toBeNull();
  });

  it("shows the empty text when nothing is tagged", () => {
    const run = fixtureRun({ stats: fixtureStats({ failure_types: { by_tag: {}, untagged: 9 } }) });
    const model = failureTypesModel(run)!;
    expect(model.emptyText).toBe("Tag failed results in the case drawer to see them grouped here.");
    expect(model.rows.map((r) => r.label)).toEqual(["Not reviewed yet"]);
  });

  it("says so when nothing failed", () => {
    const run = fixtureRun({
      stats: fixtureStats({ results_passed: 72, failure_types: { by_tag: {}, untagged: 0 } }),
    });
    const model = failureTypesModel(run)!;
    expect(model.emptyText).toBe("No failed results.");
    expect(model.rows).toEqual([]);
    expect(model.failedText).toBe("0 failed results");
  });
});

describe("overviewModel failing cases", () => {
  it("joins stats with result rows and falls back without a row", () => {
    const run = fixtureRun();
    const rows = failingCaseRows(run, [fixtureRow()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ caseId: "c012", position: "#12", title: "SQL injection in query.ts", flaky: false });
    expect(rows[1]).toMatchObject({
      caseId: "c021",
      position: "—",
      title: "c021",
      dots: ["passed", "passed", "failed"],
      scoreText: "0.74",
      flaky: true,
    });
  });

  it("caps at five and builds the header", () => {
    const failing = Array.from({ length: 8 }, (_v, i) => ({
      case_id: `c${i}`,
      pass_rate: 0,
      mean_score: 0.1,
      passes: [false],
    }));
    const run = fixtureRun({ stats: fixtureStats({ failing_cases: failing }) });
    expect(failingCaseRows(run, [])).toHaveLength(5);
    expect(failingCardHeader(run)).toEqual({ shownText: "5 of 24", allText: "All 24 cases" });
    expect(failingCardHeader(fixtureRun({ stats: null }))).toEqual({ shownText: "0 of 0", allText: "All 0 cases" });
  });
});
