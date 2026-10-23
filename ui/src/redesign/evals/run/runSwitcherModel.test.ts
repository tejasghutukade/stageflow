import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvalListItem, EvalRunListItem } from "../../../api/evalTypes";
import { evalRowModel } from "../evalListModel";
import { LiveProgress } from "./LiveProgress";
import { activeRunText, evalLandingTarget, newestRunNumber, switcherRows } from "./runSwitcherModel";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function run(n: number, extra: Partial<EvalRunListItem> = {}): EvalRunListItem {
  return {
    eval_run_id: `r${n}`,
    eval_id: "e",
    run_number: n,
    status: "completed",
    passed: true,
    pass_rate: 0.9,
    pass_rate_ci: null,
    results_executed: 10,
    cost_total: 1,
    finished_at: "2026-10-20T11:00:00Z",
    fingerprint: "f",
    label: null,
    ...extra,
  };
}

describe("run switcher rows", () => {
  it("lists newest first, marks the current run and shows progress for active runs", () => {
    const rows = switcherRows(
      [
        run(1),
        run(3, { status: "running", passed: null, pass_rate: null, finished_at: null, started_at: "2026-10-20T11:59:00Z", results_executed: 22, results_total: 60 }),
        run(2, { passed: false, pass_rate: 0.5, label: "tweak prompt" }),
      ],
      2,
      NOW,
    );
    expect(rows.map((r) => r.runNumber)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.current)).toEqual([false, true, false]);
    expect(rows[0]).toMatchObject({ statusText: "Running", tone: "running", metaText: "22/60" });
    expect(rows[1]).toMatchObject({ statusText: "Below threshold", tone: "fail", metaText: "50.0%", label: "tweak prompt" });
    expect(rows[2]).toMatchObject({ statusText: "Passed", tone: "ok", metaText: "90.0%" });
  });

  it("finds the newest run number", () => {
    expect(newestRunNumber([2, 5, 3])).toBe(5);
    expect(newestRunNumber([])).toBeNull();
  });
});

describe("landing target", () => {
  const active = { run_number: 4, eval_run_id: "r4", status: "running" as const, results_done: 1, results_total: 9 };
  it("prefers the active run, then the newest run, then the editor", () => {
    expect(evalLandingTarget({ active_run: active, last_run: { run_number: 3 }, runs_count: 4 })).toEqual({ kind: "run", runNumber: 4 });
    expect(evalLandingTarget({ active_run: null, last_run: { run_number: 3 }, runs_count: 5, newestRunNumber: 5 })).toEqual({ kind: "run", runNumber: 5 });
    expect(evalLandingTarget({ active_run: null, last_run: { run_number: 3 }, runs_count: 3 })).toEqual({ kind: "run", runNumber: 3 });
    expect(evalLandingTarget({ active_run: null, last_run: null, runs_count: 0 })).toEqual({ kind: "edit" });
  });

  it("opens a first run that has not finished yet", () => {
    expect(evalLandingTarget({ active_run: { ...active, run_number: 1 }, last_run: null, runs_count: 1 })).toEqual({ kind: "run", runNumber: 1 });
  });
});

describe("list row for an active run", () => {
  const base = {
    id: "e",
    name: "e",
    description: null,
    type: "capability",
    path: "evals/e.eval.yaml",
    target: { kind: "stage", label: "p · s" },
    dataset_path: "datasets/d.dataset.jsonl",
    dataset_cases: 3,
    repeats: 1,
    grader_count: 1,
    rubric_count: 0,
    valid: true,
    finding_count: 0,
    status: "running",
    active_run: { run_number: 1, eval_run_id: "r1", status: "running", results_done: 22, results_total: 60 },
    last_run: null,
    last_run_delta_pts: null,
    trend: [],
  } as EvalListItem;

  it("shows the run, progress and a link to the live page", () => {
    expect(activeRunText(base.active_run!)).toBe("Run #1 running · 22/60");
    const row = evalRowModel(base);
    expect(row.status).toEqual({ label: "Running", tone: "running" });
    expect(row.activeRun).toEqual({ text: "Run #1 running · 22/60", href: "/evals/e/runs/1" });
    expect(row.runsHref).toBe("/evals/e/runs/1");
  });

  it("has no active line otherwise", () => {
    const row = evalRowModel({ ...base, status: "never_run", active_run: null });
    expect(row.activeRun).toBeNull();
    expect(row.runsHref).toBeNull();
  });
});

describe("live progress layout", () => {
  it("keeps both sections from shrinking so the page scrolls instead of clipping", () => {
    const model = {
      headline: "h",
      percentText: "0%",
      total: 1,
      counts: { passed: 0, failed: 0, running: 0, queued: 1 },
      segments: [],
      passingText: "—",
      costText: "$0",
      elapsedText: "—",
      leftText: "—",
      footer: "f",
      rows: [],
    } as unknown as Parameters<typeof LiveProgress>[0]["model"];
    const html = renderToStaticMarkup(createElement(LiveProgress, { model, runNumber: 1 }));
    const sections = html.match(/<section[^>]*>/g) ?? [];
    expect(sections).toHaveLength(2);
    for (const tag of sections) expect(tag).toContain("shrink-0");
  });
});
