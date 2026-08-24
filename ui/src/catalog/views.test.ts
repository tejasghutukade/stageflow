import { describe, expect, it } from "vitest";
import type { CapacityHealth, RunSummary } from "../api";
import type { CatalogSnapshot } from "./source";
import {
  brokenView,
  capacityView,
  finishedView,
  inFlightView,
  runsFilterCounts,
  runsForPipelineView,
  runsForTaskView,
  waitingRunsAmongView,
  waitingView,
} from "./views";

function summary(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id">,
): RunSummary {
  return {
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    stages: [],
    ...overrides,
  };
}

function snapshot(
  runs: RunSummary[],
  health: CapacityHealth | null = null,
): CatalogSnapshot {
  return { runs, health };
}

const health = (
  overrides: Partial<CapacityHealth> &
    Pick<CapacityHealth, "slotsAvailable" | "activeCount" | "maxConcurrent">,
): CapacityHealth => ({
  ok: true,
  activeRunIds: [],
  ...overrides,
});

describe("catalog views", () => {
  it("waiting view returns exactly the runs with waiting_stage_id set", () => {
    const waiting = summary({
      run_id: "w",
      status: "running",
      waiting_stage_id: "ask",
    });
    const running = summary({ run_id: "r", status: "running" });
    expect(waitingView(snapshot([waiting, running])).map((run) => run.run_id)).toEqual(
      ["w"],
    );
  });

  it("in-flight view returns running or created runs and excludes waiting", () => {
    const waiting = summary({
      run_id: "w",
      status: "running",
      waiting_stage_id: "ask",
    });
    const running = summary({ run_id: "r", status: "running" });
    const created = summary({ run_id: "c", status: "created" });
    const failed = summary({ run_id: "f", status: "failed" });
    expect(
      inFlightView(snapshot([waiting, running, created, failed])).map(
        (run) => run.run_id,
      ),
    ).toEqual(["r", "c"]);
  });

  it("broken view returns failed runs and excludes waiting+failed", () => {
    const waitingFailed = summary({
      run_id: "wf",
      status: "failed",
      waiting_stage_id: "ask",
    });
    const failed = summary({ run_id: "f", status: "failed" });
    const running = summary({ run_id: "r", status: "running" });
    expect(
      brokenView(snapshot([waitingFailed, failed, running])).map((run) => run.run_id),
    ).toEqual(["f"]);
  });

  it("finished view returns succeeded runs", () => {
    const succeeded = summary({ run_id: "s", status: "succeeded" });
    const running = summary({ run_id: "r", status: "running" });
    expect(finishedView(snapshot([succeeded, running])).map((run) => run.run_id)).toEqual(
      ["s"],
    );
  });

  it("capacity view with slotsAvailable === 0 composes the no-free-slots sentence", () => {
    const runs = [
      summary({ run_id: "r1", status: "running" }),
      summary({ run_id: "r2", status: "created" }),
      summary({ run_id: "f1", status: "failed" }),
    ];
    expect(
      capacityView(
        snapshot(
          runs,
          health({ slotsAvailable: 0, activeCount: 2, maxConcurrent: 2 }),
        ),
      ).line,
    ).toBe("2 in flight · 1 failed · no free session slots");
  });

  it("capacity view with free slots includes the in-use count", () => {
    const runs = [
      summary({ run_id: "r1", status: "running" }),
      summary({ run_id: "f1", status: "failed" }),
    ];
    expect(
      capacityView(
        snapshot(
          runs,
          health({ slotsAvailable: 2, activeCount: 1, maxConcurrent: 3 }),
        ),
      ).line,
    ).toBe("1 in flight · 1 failed · 2 free slots · 1/3 in use");
    expect(
      capacityView(
        snapshot(
          runs,
          health({ slotsAvailable: 1, activeCount: 2, maxConcurrent: 3 }),
        ),
      ).line,
    ).toBe("1 in flight · 1 failed · 1 free slot · 2/3 in use");
  });

  it("per-task view returns only that task's runs, newest first", () => {
    const older = summary({
      run_id: "older",
      task_id: "task-a",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = summary({
      run_id: "newer",
      task_id: "task-a",
      created_at: "2026-06-01T00:00:00.000Z",
    });
    const other = summary({
      run_id: "other",
      task_id: "task-b",
      created_at: "2026-07-01T00:00:00.000Z",
    });
    expect(
      runsForTaskView(snapshot([older, other, newer]), "task-a").map(
        (run) => run.run_id,
      ),
    ).toEqual(["newer", "older"]);
  });

  it("per-pipeline view returns only that pipeline's runs, newest first", () => {
    const older = summary({
      run_id: "older",
      pipeline_id: "pipe-a",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = summary({
      run_id: "newer",
      pipeline_id: "pipe-a",
      created_at: "2026-06-01T00:00:00.000Z",
    });
    const other = summary({
      run_id: "other",
      pipeline_id: "pipe-b",
      created_at: "2026-07-01T00:00:00.000Z",
    });
    expect(
      runsForPipelineView(snapshot([older, other, newer]), "pipe-a").map(
        (run) => run.run_id,
      ),
    ).toEqual(["newer", "older"]);
  });

  it("empty listing yields five empty views and a capacity view that renders without health", () => {
    const empty = snapshot([]);
    expect(waitingView(empty)).toEqual([]);
    expect(inFlightView(empty)).toEqual([]);
    expect(brokenView(empty)).toEqual([]);
    expect(finishedView(empty)).toEqual([]);
    expect(runsForTaskView(empty, "task-a")).toEqual([]);
    expect(runsForPipelineView(empty, "pipe-a")).toEqual([]);
    expect(capacityView(empty).line).toBe("0 in flight · 0 failed");
    expect(capacityView(empty).health).toBeNull();
  });

  it("Runs filter counts from views match previous filterCounts for each display status", () => {
    const listing = [
      summary({ run_id: "w", waiting_stage_id: "ask" }),
      summary({ run_id: "r", status: "running" }),
      summary({ run_id: "c", status: "created" }),
      summary({ run_id: "f", status: "failed" }),
      summary({ run_id: "s", status: "succeeded" }),
    ];
    expect(runsFilterCounts(snapshot(listing))).toEqual({
      all: 5,
      waiting: 1,
      running: 2,
      failed: 1,
      finished: 1,
    });
  });

  it("new-run blocking view lists only waiting runs among activeRunIds", () => {
    const waitingActive = summary({
      run_id: "a",
      waiting_stage_id: "ask",
    });
    const runningActive = summary({ run_id: "b", status: "running" });
    const waitingInactive = summary({
      run_id: "c",
      waiting_stage_id: "ask",
    });
    const snap = snapshot(
      [waitingActive, runningActive, waitingInactive],
      health({
        slotsAvailable: 0,
        activeCount: 2,
        maxConcurrent: 2,
        activeRunIds: ["a", "b"],
      }),
    );
    expect(
      waitingRunsAmongView(snap, snap.health!.activeRunIds).map(
        (run) => run.run_id,
      ),
    ).toEqual(["a"]);
  });

  it("Today capacity sentence comes from capacityView.line", () => {
    const view = capacityView(
      snapshot(
        [
          summary({ run_id: "r1", status: "running" }),
          summary({ run_id: "f1", status: "failed" }),
        ],
        health({ slotsAvailable: 2, activeCount: 1, maxConcurrent: 3 }),
      ),
    );
    expect(view.line).toBe(
      "1 in flight · 1 failed · 2 free slots · 1/3 in use",
    );
    expect(view.health?.slotsAvailable).toBe(2);
  });
});
