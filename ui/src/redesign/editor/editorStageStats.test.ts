import { describe, expect, it } from "vitest";
import type { RunDetail, RunSummary, StageSnapshot } from "../../api";
import {
  mergeDurations,
  recentTerminalRuns,
  runP50Ms,
  stageDurationsFromDetail,
  summaryStageStats,
  type StageStats,
} from "./editorStageStats";

function summary(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id" | "status">,
): RunSummary {
  return {
    pipeline_id: "feature-ship",
    created_at: "2026-01-01T00:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

function stage(
  id: string,
  status: RunSummary["stages"][number]["status"],
  cost_usd?: number,
): RunSummary["stages"][number] {
  return {
    id,
    status,
    attempt_count: 1,
    ...(cost_usd !== undefined ? { cost_usd } : {}),
  };
}

function snapshot(
  stageId: string,
  ats: Array<string | undefined>,
): StageSnapshot {
  return {
    stage_id: stageId,
    status: "succeeded",
    events: ats.map((at) => ({ event: "log", ...(at !== undefined ? { at } : {}) })),
    envelope: null,
    artifacts: [],
    attempt_count: 1,
  };
}

function detail(
  run: RunSummary,
  stages: StageSnapshot[],
): RunDetail {
  return {
    ...run,
    task_yaml: "",
    stages,
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
  };
}

describe("summaryStageStats", () => {
  it("counts terminal stages and computes pass rate", () => {
    const stats = summaryStageStats([
      summary({
        run_id: "r1",
        status: "succeeded",
        stages: [stage("review", "succeeded"), stage("ship", "failed")],
      }),
      summary({
        run_id: "r2",
        status: "failed",
        stages: [stage("review", "succeeded"), stage("ship", "succeeded")],
      }),
      summary({
        run_id: "r3",
        status: "failed",
        stages: [stage("review", "failed")],
      }),
    ]);

    expect(stats.get("review")).toEqual({ runs: 3, passRate: 2 / 3 });
    expect(stats.get("ship")).toEqual({ runs: 2, passRate: 0.5 });
  });

  it("averages only defined finite costs and omits avgCostUsd when none exist", () => {
    const stats = summaryStageStats([
      summary({
        run_id: "r1",
        status: "succeeded",
        stages: [stage("review", "succeeded", 1), stage("ship", "failed")],
      }),
      summary({
        run_id: "r2",
        status: "succeeded",
        stages: [
          stage("review", "succeeded", Number.NaN),
          stage("ship", "succeeded", 0),
        ],
      }),
      summary({
        run_id: "r3",
        status: "failed",
        stages: [stage("review", "failed", 3)],
      }),
    ]);

    expect(stats.get("review")).toEqual({
      runs: 3,
      passRate: 2 / 3,
      avgCostUsd: 2,
    });
    expect(stats.get("ship")).toEqual({
      runs: 2,
      passRate: 0.5,
      avgCostUsd: 0,
    });
    expect(stats.get("ship")).not.toHaveProperty("avgMs");
  });

  it("ignores non-terminal stage statuses and counts a stage once per run", () => {
    const stats = summaryStageStats([
      summary({
        run_id: "r1",
        status: "running",
        stages: [
          stage("review", "running"),
          stage("review", "succeeded", 4),
          stage("review", "failed", 9),
          stage("draft", "skipped"),
        ],
      }),
    ]);

    expect(stats.get("review")).toEqual({
      runs: 1,
      passRate: 1,
      avgCostUsd: 4,
    });
    expect(stats.has("draft")).toBe(false);
  });

  it("reports a zero pass rate when every counted appearance failed", () => {
    const stats = summaryStageStats([
      summary({
        run_id: "r1",
        status: "failed",
        stages: [stage("ship", "failed", 1.5)],
      }),
    ]);
    expect(stats.get("ship")).toEqual({
      runs: 1,
      passRate: 0,
      avgCostUsd: 1.5,
    });
  });
});

describe("runP50Ms", () => {
  it("returns null when no succeeded run has a usable duration", () => {
    expect(
      runP50Ms([
        summary({
          run_id: "failed",
          status: "failed",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z",
        }),
        summary({
          run_id: "open",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
        summary({
          run_id: "bad",
          status: "succeeded",
          created_at: "not-a-date",
          finished_at: "2026-01-01T00:01:00.000Z",
        }),
        summary({
          run_id: "negative",
          status: "succeeded",
          created_at: "2026-01-01T00:02:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z",
        }),
      ]),
    ).toBeNull();
  });

  it("returns the middle duration for an odd number of succeeded runs", () => {
    expect(
      runP50Ms([
        summary({
          run_id: "c",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:30.000Z",
        }),
        summary({
          run_id: "a",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:10.000Z",
        }),
        summary({
          run_id: "b",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:20.000Z",
        }),
      ]),
    ).toBe(20_000);
  });

  it("averages the two middle durations for an even number of succeeded runs", () => {
    expect(
      runP50Ms([
        summary({
          run_id: "d",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:40.000Z",
        }),
        summary({
          run_id: "a",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:10.000Z",
        }),
        summary({
          run_id: "c",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:30.000Z",
        }),
        summary({
          run_id: "b",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:20.000Z",
        }),
        summary({
          run_id: "ignored",
          status: "cancelled",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T01:00:00.000Z",
        }),
      ]),
    ).toBe(25_000);
  });

  it("includes a zero duration", () => {
    expect(
      runP50Ms([
        summary({
          run_id: "zero",
          status: "succeeded",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    ).toBe(0);
  });
});

describe("stageDurationsFromDetail", () => {
  it("uses max minus min of parseable event timestamps", () => {
    const durations = stageDurationsFromDetail(
      detail(
        summary({ run_id: "r1", status: "succeeded" }),
        [
          snapshot("review", [
            "2026-01-01T00:00:20.000Z",
            "not-a-date",
            undefined,
            "2026-01-01T00:00:05.000Z",
            "2026-01-01T00:00:12.000Z",
          ]),
          snapshot("ship", ["2026-01-01T00:01:00.000Z"]),
          snapshot("draft", []),
          snapshot("same", [
            "2026-01-01T00:02:00.000Z",
            "2026-01-01T00:02:00.000Z",
          ]),
        ],
      ),
    );

    expect(durations.get("review")).toBe(15_000);
    expect(durations.has("ship")).toBe(false);
    expect(durations.has("draft")).toBe(false);
    expect(durations.get("same")).toBe(0);
  });

  it("keeps the later snapshot when a stage id repeats", () => {
    const durations = stageDurationsFromDetail(
      detail(summary({ run_id: "r1", status: "succeeded" }), [
        snapshot("review", [
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:01.000Z",
        ]),
        snapshot("review", [
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:04.000Z",
        ]),
      ]),
    );
    expect(durations.get("review")).toBe(4_000);
  });
});

describe("mergeDurations", () => {
  it("sets avgMs to the mean of runs that have a duration for that stage", () => {
    const base = new Map<string, StageStats>([
      ["review", { runs: 4, passRate: 0.75, avgCostUsd: 0.1 }],
      ["ship", { runs: 1, passRate: 0 }],
    ]);
    const merged = mergeDurations(base, [
      new Map([
        ["review", 1_000],
        ["ship", -20],
      ]),
      new Map([
        ["review", 3_000],
        ["ship", Number.NaN],
      ]),
      new Map([["review", Number.POSITIVE_INFINITY]]),
    ]);

    expect(merged.get("review")).toEqual({
      runs: 4,
      passRate: 0.75,
      avgCostUsd: 0.1,
      avgMs: 2_000,
    });
    expect(merged.get("ship")).toEqual({ runs: 1, passRate: 0 });
    expect(base.get("review")).toEqual({
      runs: 4,
      passRate: 0.75,
      avgCostUsd: 0.1,
    });
  });

  it("keeps duration-only stages with zero runs when summaries never saw them", () => {
    const base = summaryStageStats([
      summary({
        run_id: "r1",
        status: "succeeded",
        stages: [stage("review", "succeeded")],
      }),
    ]);
    const merged = mergeDurations(base, [
      new Map([
        ["review", 2_000],
        ["orphan", 500],
      ]),
      new Map([["orphan", 1_500]]),
    ]);

    expect(merged.get("review")).toEqual({
      runs: 1,
      passRate: 1,
      avgMs: 2_000,
    });
    expect(merged.get("orphan")).toEqual({ runs: 0, avgMs: 1_000 });
  });
});

describe("recentTerminalRuns", () => {
  it("keeps the eight newest succeeded or failed runs", () => {
    const runs = [
      summary({
        run_id: "running",
        status: "running",
        created_at: "2026-01-10T00:00:00.000Z",
      }),
      summary({
        run_id: "cancelled",
        status: "cancelled",
        created_at: "2026-01-09T00:00:00.000Z",
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        summary({
          run_id: `t${index}`,
          status: index % 2 === 0 ? "succeeded" : "failed",
          created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
        }),
      ),
    ];
    expect(recentTerminalRuns(runs).map((run) => run.run_id)).toEqual([
      "t8",
      "t7",
      "t6",
      "t5",
      "t4",
      "t3",
      "t2",
      "t1",
    ]);
  });

  it("breaks equal timestamps by run id", () => {
    const at = "2026-01-01T00:00:00.000Z";
    expect(
      recentTerminalRuns([
        summary({ run_id: "b", status: "failed", created_at: at }),
        summary({ run_id: "a", status: "succeeded", created_at: at }),
      ]).map((run) => run.run_id),
    ).toEqual(["a", "b"]);
  });
});
