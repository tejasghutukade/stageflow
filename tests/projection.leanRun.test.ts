import { describe, expect, it } from "vitest";
import { projectRun } from "../src/projection/projectRun.js";
import type { RunDetail, StageSnapshot } from "../src/runstore/port.js";

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id" | "status">,
): StageSnapshot {
  return {
    events: [{ event: "started" }, { event: "succeeded" }],
    envelope: {
      status: "success",
      summary: "ok",
      artifacts: [],
    },
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "docs-only",
    status: "succeeded",
    created_at: "2026-01-01T00:00:00.000Z",
    task_yaml: "id: t\ngoal: g\n",
    stages: [stage({ stage_id: "clarify", status: "succeeded" })],
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
    ...overrides,
  };
}

describe("projectRun lean cost and definition_id", () => {
  it("copies total_cost_usd, per-stage cost_usd, and definition_id when the store has them", () => {
    const projected = projectRun(
      detail({
        total_cost_usd: 0.05,
        stages: [
          stage({
            stage_id: "author-diagrams~2",
            definition_id: "author-diagrams",
            status: "succeeded",
            cost_usd: 0.0123,
          }),
        ],
      }),
    );
    expect(projected.total_cost_usd).toBe(0.05);
    expect(projected.stages).toHaveLength(1);
    expect(projected.stages[0]?.stage_id).toBe("author-diagrams~2");
    expect(projected.stages[0]?.cost_usd).toBe(0.0123);
    expect(projected.stages[0]?.definition_id).toBe("author-diagrams");
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
  });

  it("omits cost fields when the store has no usage rather than inventing 0", () => {
    const projected = projectRun(detail());
    expect(projected).not.toHaveProperty("total_cost_usd");
    expect(projected.stages[0]).not.toHaveProperty("cost_usd");
    expect(projected.stages[0]).not.toHaveProperty("definition_id");
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
  });

  it("keeps a recorded 0 cost and still omits unused definition_id", () => {
    const projected = projectRun(
      detail({
        total_cost_usd: 0,
        stages: [
          stage({
            stage_id: "clarify",
            status: "succeeded",
            cost_usd: 0,
          }),
        ],
      }),
    );
    expect(projected.total_cost_usd).toBe(0);
    expect(projected.stages[0]?.cost_usd).toBe(0);
    expect(projected.stages[0]).not.toHaveProperty("definition_id");
  });
});
