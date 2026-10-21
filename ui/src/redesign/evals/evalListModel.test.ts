import { describe, expect, it } from "vitest";
import type { EvalListItem, EvalRunHeadline } from "../../api";
import {
  bannerModel,
  datasetName,
  engineBanner,
  evalRowModel,
  evalTabs,
  filterEvals,
  footerText,
  moveSelection,
  saturatedGuidance,
  statusOf,
  trendDots,
} from "./evalListModel";

function headline(over: Partial<EvalRunHeadline> = {}): EvalRunHeadline {
  return {
    eval_run_id: "er_1",
    eval_id: "x",
    run_number: 3,
    status: "completed",
    passed: true,
    pass_rate: 0.875,
    pass_rate_ci: null,
    results_executed: 24,
    cost_total: 0.64,
    finished_at: "2026-10-20T10:00:00Z",
    fingerprint: "abcd1234",
    label: null,
    ...over,
  };
}

function item(over: Partial<EvalListItem> = {}): EvalListItem {
  return {
    id: "review-findings",
    name: "review-findings",
    description: "Review flags real defects",
    type: "capability",
    path: "evals/review-findings.eval.yaml",
    target: { kind: "stage", pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review", label: "feature-ship · review" },
    dataset_path: "datasets/review-diffs.dataset.jsonl",
    dataset_cases: 24,
    repeats: 3,
    grader_count: 2,
    rubric_count: 1,
    valid: true,
    finding_count: 0,
    status: "passing",
    last_run: headline(),
    last_run_delta_pts: 2.1,
    trend: [],
    ...over,
  };
}

const passing = item();
const saturated = item({ id: "changelog-format", name: "changelog-format", status: "saturated", last_run: headline({ pass_rate: 1 }), last_run_delta_pts: 7.5 });
const regressed = item({
  id: "triage-severity",
  name: "triage-severity",
  status: "regressed",
  target: { kind: "stage", pipeline_path: "p.yaml", stage_id: "triage", label: "issue-intake · triage" },
  dataset_path: "datasets/triage-labelled.dataset.jsonl",
  last_run: headline({ pass_rate: 0.783, passed: false, cost_total: 1.12 }),
  last_run_delta_pts: -9.2,
});
const neverRun = item({ id: "critique-sample", name: "critique-sample", status: "never_run", last_run: null, last_run_delta_pts: null });
const all = [passing, saturated, regressed, neverRun];

describe("evalTabs", () => {
  it("counts all, stages and regressed, with Agents as a soon tab", () => {
    expect(evalTabs(all)).toEqual([
      { id: "all", label: "All", count: 4 },
      { id: "stages", label: "Stages", count: 4 },
      { id: "agents", label: "Agents", soon: true },
      { id: "regressed", label: "Regressed", count: 1 },
    ]);
  });
});

describe("filterEvals", () => {
  it("filters by tab", () => {
    expect(filterEvals(all, { tab: "regressed", query: "" }).map((i) => i.id)).toEqual(["triage-severity"]);
    expect(filterEvals(all, { tab: "stages", query: "" })).toHaveLength(4);
    expect(filterEvals(all, { tab: "agents", query: "" })).toHaveLength(0);
  });
  it("searches id, name, stage id and dataset", () => {
    expect(filterEvals(all, { tab: "all", query: "TRIAGE" }).map((i) => i.id)).toEqual(["triage-severity"]);
    expect(filterEvals(all, { tab: "all", query: "review-diffs" }).map((i) => i.id)).toContain("review-findings");
    expect(filterEvals(all, { tab: "all", query: " review " }).map((i) => i.id)).toContain("review-findings");
    expect(filterEvals(all, { tab: "all", query: "nope" })).toEqual([]);
  });
  it("narrows to one stage from the route", () => {
    expect(filterEvals(all, { tab: "all", query: "", stage: "triage" }).map((i) => i.id)).toEqual(["triage-severity"]);
  });
});

describe("statusOf", () => {
  it("maps each status to a word and tone", () => {
    expect(statusOf(passing)).toEqual({ label: "Passing", tone: "ok" });
    expect(statusOf(saturated)).toEqual({ label: "Saturated", tone: "needs" });
    expect(statusOf(regressed)).toEqual({ label: "Regressed", tone: "fail" });
    expect(statusOf(neverRun)).toEqual({ label: "Never run", tone: "muted" });
    expect(statusOf(item({ status: "failing" }))).toEqual({ label: "Failing", tone: "fail" });
  });
  it("shows Needs fixing for an invalid eval whatever its status", () => {
    expect(statusOf(item({ valid: false }))).toEqual({ label: "Needs fixing", tone: "needs" });
  });
});

describe("trendDots", () => {
  it("colors passed, near-miss and miss, and pads to seven", () => {
    const dots = trendDots(
      item({
        trend: [
          { run_number: 1, passed: true, pass_rate: 0.9, pass_threshold: 0.8 },
          { run_number: 2, passed: false, pass_rate: 0.76, pass_threshold: 0.8 },
          { run_number: 3, passed: false, pass_rate: 0.7, pass_threshold: 0.8 },
          { run_number: 4, passed: false, pass_rate: null, pass_threshold: 0.8 },
        ],
      }),
    );
    expect(dots.map((d) => d.tone)).toEqual(["ok", "needs", "fail", "fail", "empty", "empty", "empty"]);
    expect(dots[0]?.title).toBe("Run #1 · 90.0%");
  });
  it("is all empty for a never-run eval", () => {
    expect(trendDots(neverRun).every((d) => d.tone === "empty")).toBe(true);
  });
});

describe("evalRowModel", () => {
  it("builds the passing row", () => {
    const row = evalRowModel(passing);
    expect(row).toMatchObject({
      name: "review-findings",
      targetLabel: "feature-ship · review",
      targetPath: "pipelines/feature-ship.pipeline.yaml",
      datasetName: "review-diffs",
      datasetMeta: "Capability · 24 cases · 3 repeats",
      rateText: "87.5%",
      rateTone: "ok",
      deltaText: "+2.1 pts",
      deltaTone: "ok",
      barPercent: 88,
      costText: "$0.64",
      href: "/evals/review-findings",
    });
  });
  it("signs a regression with a minus and red", () => {
    const row = evalRowModel(regressed);
    expect(row.deltaText).toBe("−9.2 pts");
    expect(row.deltaTone).toBe("fail");
    expect(row.rateTone).toBe("fail");
    expect(row.costText).toBe("$1.12");
  });
  it("shows the never-run row without numbers", () => {
    const row = evalRowModel(neverRun);
    expect(row).toMatchObject({ hasRun: false, deltaText: null, barPercent: 0, costText: "—" });
    expect(row.datasetMeta).toBe("Capability · 24 cases · sample data");
  });
  it("uses the file for a file target and singular units", () => {
    const row = evalRowModel(
      item({ target: { kind: "stage", file: "stages/x.yaml", label: "x" }, dataset_cases: 1, repeats: 1 }),
    );
    expect(row.targetPath).toBe("stages/x.yaml");
    expect(row.datasetMeta).toBe("Capability · 1 case · 1 repeat");
  });
  it("opens an invalid eval on its edit page", () => {
    expect(evalRowModel(item({ valid: false })).href).toBe("/evals/review-findings/edit");
  });
  it("falls back to the id when the name is empty", () => {
    expect(evalRowModel(item({ name: "" })).name).toBe("review-findings");
  });
});

describe("datasetName", () => {
  it("strips directories and the dataset extension", () => {
    expect(datasetName("datasets/a.dataset.jsonl")).toBe("a");
    expect(datasetName("x/b.csv")).toBe("b");
  });
});

describe("bannerModel", () => {
  it("is null without a banner", () => {
    expect(bannerModel(null)).toBeNull();
  });
  it("links Compare with the right run numbers", () => {
    expect(
      bannerModel({
        eval_id: "triage-severity",
        previous_pass_rate: 0.875,
        last_pass_rate: 0.783,
        criteria_dropped: 2,
        last_run_number: 14,
        previous_run_number: 13,
      }),
    ).toEqual({
      title: "triage-severity regressed",
      detail: "Pass rate 87.5% → 78.3% · 2 criteria dropped · run #14 vs #13",
      compareHref: "/evals/triage-severity/compare?a=13&b=14",
    });
  });
});

describe("saturatedGuidance", () => {
  it("names the saturated eval", () => {
    expect(saturatedGuidance(all)).toBe(
      "changelog-format passes every case, so it can no longer show improvement. Move it to a regression eval to keep guarding it, and add harder cases to a new capability eval.",
    );
  });
  it("is omitted otherwise", () => {
    expect(saturatedGuidance([passing, regressed])).toBeNull();
  });
});

describe("footerText", () => {
  it("summarises evals, datasets and spend", () => {
    expect(footerText({ evals: 4, datasets: 3, cost_last_7_days: 2.67 })).toBe(
      "4 evals in evals/ · 3 datasets in datasets/ · $2.67 in the last 7 days",
    );
    expect(footerText({ evals: 1, datasets: 1, cost_last_7_days: 0 })).toBe(
      "1 eval in evals/ · 1 dataset in datasets/ · $0.00 in the last 7 days",
    );
  });
});

describe("engineBanner", () => {
  const base = { installed: true, version: "1", pinned: "1", node: "v18.0.0", node_ok: true, install_command: "sf eval engine install" };
  it("is hidden when the engine is ready or unknown", () => {
    expect(engineBanner(base)).toBeNull();
    expect(engineBanner(null)).toBeNull();
  });
  it("shows the command when not installed", () => {
    expect(engineBanner({ ...base, installed: false, version: null })).toEqual({
      reason: "The eval engine is not installed. Evals cannot run until it is.",
      command: "sf eval engine install",
    });
  });
  it("shows a banner when Node is too old", () => {
    const banner = engineBanner({ ...base, node_ok: false });
    expect(banner?.reason).toContain("v18.0.0");
    expect(banner?.command).toBe("sf eval engine install");
  });
});

describe("moveSelection", () => {
  const ids = ["a", "b", "c"];
  it("starts at the ends and clamps", () => {
    expect(moveSelection(ids, null, 1)).toBe("a");
    expect(moveSelection(ids, null, -1)).toBe("c");
    expect(moveSelection(ids, "a", -1)).toBe("a");
    expect(moveSelection(ids, "c", 1)).toBe("c");
    expect(moveSelection(ids, "a", 1)).toBe("b");
  });
  it("recovers when the selection left the list and handles empty", () => {
    expect(moveSelection(ids, "gone", 1)).toBe("a");
    expect(moveSelection([], "a", 1)).toBeNull();
  });
});
