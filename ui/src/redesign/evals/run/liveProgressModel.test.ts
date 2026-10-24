import { describe, expect, it } from "vitest";
import type { EvalResultRow, EvalRunDetail } from "../../../api/evalTypes";
import {
  buildCounts,
  buildLiveModel,
  buildRows,
  compareIntentKey,
  decideFinish,
  estimatedLeftMs,
  incompleteBanner,
  isActiveStatus,
  liveSubtitle,
  parseCompareIntent,
} from "./liveProgressModel";

const START = Date.parse("2026-10-20T10:00:00Z");

function run(overrides: Partial<EvalRunDetail> = {}): EvalRunDetail {
  return {
    eval_run_id: "r15",
    run_number: 15,
    eval_id: "e",
    eval_path: "evals/e.eval.yaml",
    status: "running",
    status_reason: null,
    passed: null,
    label: null,
    started_via: "console",
    created_at: "2026-10-20T10:00:00Z",
    started_at: "2026-10-20T10:00:00Z",
    finished_at: null,
    progress: { results_done: 4, results_total: 12, cost_usd: 0.37, max_cost_usd: 2, cases_total: 4 },
    config: { settings: { repeats: 3, pass_threshold: 0.8 } },
    fingerprint: "f",
    components: {},
    stats: null,
    lowest_cases_by_grader: {},
    current: { stage_version_hash: null, dataset_hash: null, grader_hashes: null },
    live: [],
    ...overrides,
  };
}

function row(caseId: string, position: number, repeats: Array<[number, "completed" | "error", boolean, number | null]>, title: string | null = null, meanScore: number | null = null): EvalResultRow {
  return {
    case_id: caseId,
    position,
    title,
    tags: [],
    repeats: repeats.map(([repeat_index, status, passed, score]) => ({ repeat_index, status, passed, score })),
    pass_fraction: null,
    mean_score: meanScore,
    failed_graders: [],
    latency_ms_p50: null,
    cost_usd: 0,
    failure_tags: [],
  };
}

const cases = [
  { id: "c1", title: "First", position: 1 },
  { id: "c2", title: "Second", position: 2 },
  { id: "c3", title: null, position: 3 },
  { id: "c4", title: "Fourth", position: 4 },
];

describe("counts", () => {
  it("always sum to the total", () => {
    const rows = [
      row("c1", 1, [[0, "completed", true, 1], [1, "completed", true, 1], [2, "completed", true, 1]]),
      row("c2", 2, [[0, "completed", false, 0.2], [1, "error", false, null]]),
    ];
    const live = [
      { case_id: "c2", repeat_index: 2, phase: "stage_running" as const },
      { case_id: "c3", repeat_index: 0, phase: "grading" as const },
    ];
    const counts = buildCounts({ total: 12, rows, live });
    expect(counts).toEqual({ passed: 3, failed: 2, running: 2, queued: 5 });
    expect(counts.passed + counts.failed + counts.running + counts.queued).toBe(12);
  });

  it("does not double count a finished result still listed as live", () => {
    const rows = [row("c1", 1, [[0, "completed", true, 1]])];
    const live = [{ case_id: "c1", repeat_index: 0, phase: "grading" as const }];
    const counts = buildCounts({ total: 3, rows, live });
    expect(counts).toEqual({ passed: 1, failed: 0, running: 0, queued: 2 });
  });

  it("clamps when rows exceed the total", () => {
    const rows = [row("c1", 1, [[0, "completed", true, 1], [1, "completed", false, 0]])];
    const counts = buildCounts({ total: 1, rows, live: [] });
    expect(counts.passed + counts.failed + counts.running + counts.queued).toBe(1);
  });
});

describe("estimated left", () => {
  it("is empty until 3 results are done", () => {
    expect(estimatedLeftMs(60_000, 2, 12)).toBeNull();
    expect(estimatedLeftMs(60_000, 0, 12)).toBeNull();
  });

  it("is elapsed / done x remaining", () => {
    expect(estimatedLeftMs(60_000, 3, 12)).toBe(180_000);
  });

  it("is empty with no remaining work or no start", () => {
    expect(estimatedLeftMs(60_000, 12, 12)).toBeNull();
    expect(estimatedLeftMs(null, 5, 12)).toBeNull();
  });
});

describe("live model", () => {
  it("builds tiles, segments and rows", () => {
    const results = [
      row("c1", 1, [[0, "completed", true, 1], [1, "completed", true, 0.8], [2, "completed", true, 0.9]], "First"),
      row("c2", 2, [[0, "completed", true, 0.9], [1, "completed", false, 0.3]], "Second"),
    ];
    const r = run({
      progress: { results_done: 5, results_total: 12, cost_usd: 0.37, max_cost_usd: 2, cases_total: 4 },
      live: [
        { case_id: "c2", repeat_index: 2, phase: "grading" },
        { case_id: "c3", repeat_index: 0, phase: "stage_running" },
      ],
    });
    const model = buildLiveModel({ run: r, results, cases, now: START + 100_000 });
    expect(model.headline).toBe("5 of 12 results graded · 2 in progress");
    expect(model.percentText).toBe("42%");
    expect(model.passingText).toBe("80.0%");
    expect(model.costText).toBe("$0.37 of $2.00 limit");
    expect(model.elapsedText).toBe("1 m 40 s");
    expect(model.leftText).toBe("about 2 m 20 s");
    expect(model.counts).toEqual({ passed: 4, failed: 1, running: 2, queued: 5 });
    expect(model.segments.map((s) => s.kind)).toEqual(["passed", "failed", "running", "queued"]);
    expect(model.segments.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100);
    expect(model.footer).toContain("$2.00 limit");
    expect(model.rows.map((x) => x.caseId)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("shows dashes before there is anything to compute", () => {
    const r = run({
      status: "queued",
      started_at: null,
      progress: { results_done: 0, results_total: 12, cost_usd: 0, max_cost_usd: 2, cases_total: 4 },
    });
    const model = buildLiveModel({ run: r, results: [], cases, now: START });
    expect(model.passingText).toBe("—");
    expect(model.elapsedText).toBe("—");
    expect(model.leftText).toBe("—");
    expect(model.costText).toBe("$0.00 of $2.00 limit");
  });
});

describe("rows", () => {
  const results = [
    row("c1", 1, [[0, "completed", true, 1], [1, "completed", true, 0.5], [2, "completed", true, 0.9]], "First", 0.8),
    row("c2", 2, [[0, "completed", true, 0.9], [1, "completed", false, 0.3]], null, 0.6),
  ];
  const r = run({
    live: [
      { case_id: "c2", repeat_index: 2, phase: "grading" },
      { case_id: "c3", repeat_index: 0, phase: "stage_running" },
    ],
  });
  const rows = buildRows({ run: r, rows: results, cases });

  it("derives repeat dots", () => {
    expect(rows[0]!.dots).toEqual(["passed", "passed", "passed"]);
    expect(rows[1]!.dots).toEqual(["passed", "failed", "running"]);
    expect(rows[2]!.dots).toEqual(["running", "queued", "queued"]);
    expect(rows[3]!.dots).toEqual(["queued", "queued", "queued"]);
  });

  it("derives the Now column from live", () => {
    expect(rows.map((x) => x.nowText)).toEqual([
      "Done",
      "Judge is grading repeat 3",
      "Stage is running repeat 1",
      "Queued",
    ]);
    expect(rows[1]!.nowTone).toBe("running");
    expect(rows[3]!.nowTone).toBe("muted");
  });

  it("shows the server mean score", () => {
    expect(rows[0]!.scoreText).toBe("0.80");
    expect(rows[1]!.scoreText).toBe("0.60");
    expect(rows[3]!.scoreText).toBe("—");
    expect(rows[3]!.scoreTone).toBe("muted");
  });

  it("labels with title, then case id", () => {
    expect(rows[0]!.label).toBe("First");
    expect(rows[2]!.label).toBe("c3");
  });

  it("limits queued rows to a subset run and skips skipped cases", () => {
    const subset = run({
      components: { case_ids: ["c1", "c4"] },
      config: { settings: { repeats: 3 }, dataset: { skipped_case_ids: ["c4"] } },
    });
    expect(buildRows({ run: subset, rows: [], cases }).map((x) => x.caseId)).toEqual(["c1"]);
  });

  it("still lists arrived cases when the dataset is unavailable", () => {
    const only = buildRows({ run: r, rows: results, cases: null });
    expect(only.map((x) => x.caseId)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("banner", () => {
  const base = { progress: { results_done: 1, results_total: 2, cost_usd: 2, max_cost_usd: 2, cases_total: 1 } };

  it("states the cost limit for budget_stopped", () => {
    expect(incompleteBanner({ ...base, status: "budget_stopped", status_reason: null })).toEqual({
      tone: "needs",
      text: "Reached the $2.00 cost limit. Results are partial.",
    });
  });

  it("shows the status reason for failed", () => {
    expect(incompleteBanner({ ...base, status: "failed", status_reason: "Engine crashed" })?.text).toBe("Engine crashed");
    expect(incompleteBanner({ ...base, status: "failed", status_reason: null })?.tone).toBe("fail");
  });

  it("covers cancelled and has none for completed", () => {
    expect(incompleteBanner({ ...base, status: "cancelled", status_reason: null })?.text).toContain("partial");
    expect(incompleteBanner({ ...base, status: "completed", status_reason: null })).toBeNull();
  });
});

describe("finish routing", () => {
  const done = (status: EvalRunDetail["status"]) => ({
    status,
    status_reason: null,
    run_number: 15,
    progress: { results_done: 12, results_total: 12, cost_usd: 1, max_cost_usd: 2, cases_total: 4 },
  });

  it("stays while active or when nothing was observed running", () => {
    expect(decideFinish({ previousStatus: "running", run: done("running"), compareWith: 14 })).toEqual({ kind: "stay" });
    expect(decideFinish({ previousStatus: null, run: done("completed"), compareWith: 14 })).toEqual({ kind: "stay" });
    expect(decideFinish({ previousStatus: "completed", run: done("completed"), compareWith: 14 })).toEqual({ kind: "stay" });
  });

  it("goes to Overview results, or Compare when the checkbox was set", () => {
    expect(decideFinish({ previousStatus: "running", run: done("completed"), compareWith: null })).toEqual({
      kind: "results",
      banner: null,
    });
    expect(decideFinish({ previousStatus: "queued", run: done("completed"), compareWith: 14 })).toEqual({
      kind: "compare",
      a: 14,
      b: 15,
    });
  });

  it("opens results with a banner for incomplete runs even when compare was set", () => {
    const result = decideFinish({ previousStatus: "running", run: done("budget_stopped"), compareWith: 14 });
    expect(result).toEqual({
      kind: "results",
      banner: { tone: "needs", text: "Reached the $2.00 cost limit. Results are partial." },
    });
  });
});

describe("subtitle", () => {
  it("describes the target, dataset and age", () => {
    const r = run({
      config: {
        settings: { repeats: 3 },
        target: { stage_id: "review", pipeline_path: "pipelines/feature-ship.pipeline.yaml" },
        dataset: { path: "datasets/review-diffs.dataset.jsonl" },
      },
      progress: { results_done: 1, results_total: 72, cost_usd: 0, max_cost_usd: 2, cases_total: 24 },
    });
    expect(liveSubtitle(r, START + 112_000)).toBe(
      "Stage review in feature-ship · review-diffs, 24 cases × 3 repeats · started 1 m 52 s ago",
    );
  });

  it("copes with a queued run and missing config", () => {
    expect(liveSubtitle(run({ config: {}, started_at: null }), START)).toBe("4 cases · waiting to start");
  });
});

describe("misc", () => {
  it("knows active statuses", () => {
    expect(isActiveStatus("queued")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
  });

  it("round-trips compare intent", () => {
    expect(compareIntentKey("e", 15)).toBe("sf.evals.compareWith.e.15");
    expect(parseCompareIntent("14")).toBe(14);
    expect(parseCompareIntent(null)).toBeNull();
    expect(parseCompareIntent("x")).toBeNull();
    expect(parseCompareIntent("0")).toBeNull();
  });
});
