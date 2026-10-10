import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { groupRunsForDisplay } from "./runsGrouping";

function run(
  id: string,
  createdAt: string,
  extra: Partial<RunSummary> = {},
): RunSummary {
  return {
    run_id: id,
    pipeline_id: "p",
    task_id: "t",
    task_path: "tasks/t.yaml",
    pipeline_path: "pipelines/p.yaml",
    status: "running",
    created_at: createdAt,
    updated_at: createdAt,
    binding: undefined,
    stages: [],
    ...extra,
  };
}

describe("groupRunsForDisplay", () => {
  const now = Date.parse("2026-10-05T18:00:00.000Z");
  const todayMorning = "2026-10-05T10:00:00.000Z";
  const yesterday = "2026-10-04T10:00:00.000Z";

  it("orders needs you before running", () => {
    const runs = [
      run("r1", todayMorning, { status: "running" }),
      run("r2", todayMorning, {
        status: "running",
        waiting_stage_id: "gate",
      }),
    ];
    const groups = groupRunsForDisplay(runs, "all", now);
    expect(groups.map((g) => g.id)).toEqual(["needs_you", "running"]);
    expect(groups[0].runs[0].run_id).toBe("r2");
  });

  it("splits earlier today vs earlier when filter is all", () => {
    const runs = [
      run("old", yesterday, { status: "succeeded" }),
      run("today", todayMorning, { status: "succeeded" }),
    ];
    const groups = groupRunsForDisplay(runs, "all", now);
    expect(groups.map((g) => g.id)).toEqual(["earlier_today", "earlier"]);
  });
});
