import { describe, expect, it } from "vitest";
import type { RunSummary } from "../api";
import { aggregatePipelineStats } from "./stats";

function run(
  overrides: Partial<RunSummary> & Pick<RunSummary, "run_id" | "pipeline_id">,
): RunSummary {
  return {
    run_id: overrides.run_id,
    pipeline_id: overrides.pipeline_id,
    task_id: overrides.task_id ?? "tasks/a.yaml",
    status: overrides.status ?? "succeeded",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:10:00.000Z",
    finished_at: overrides.finished_at ?? "2026-01-01T00:10:00.000Z",
    stages: overrides.stages ?? [],
    total_cost_usd: overrides.total_cost_usd,
    waiting_stage_id: overrides.waiting_stage_id,
    waiting_kind: overrides.waiting_kind,
    waiting_summary: overrides.waiting_summary,
    project_root: overrides.project_root,
    task_path: overrides.task_path,
  };
}

describe("aggregatePipelineStats", () => {
  it("averages succeeded runs only", () => {
    const runs: RunSummary[] = [
      run({
        run_id: "a",
        pipeline_id: "ship",
        total_cost_usd: 2,
        created_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:20:00.000Z",
      }),
      run({
        run_id: "b",
        pipeline_id: "ship",
        status: "failed",
        total_cost_usd: 99,
      }),
      run({
        run_id: "c",
        pipeline_id: "other",
        total_cost_usd: 1,
      }),
    ];
    const stats = aggregatePipelineStats(runs, "ship");
    expect(stats.sampleCount).toBe(1);
    expect(stats.avgCostUsd).toBe(2);
    expect(stats.avgDurationMs).toBe(20 * 60_000);
  });
});
