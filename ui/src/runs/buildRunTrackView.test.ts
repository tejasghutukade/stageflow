import { describe, expect, it } from "vitest";
import type { RunDetail } from "../api";
import { buildRunTrackView, listWaitingHeader } from "./buildRunTrackView";

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: "r1",
    pipeline_id: "p",
    status: "running",
    created_at: "2026-10-05T10:00:00.000Z",
    binding: { kind: "unbound" },
    task_yaml: "",
    stages: [],
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
    ...overrides,
  } as RunDetail;
}

describe("buildRunTrackView", () => {
  it("builds list header from waiting stage label", () => {
    const detail = run({
      waiting_stage_id: "review",
      stages: [
        {
          stage_id: "review",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
          attempt_count: 1,
        },
      ],
      pipeline_track: {
        nodes: [
          {
            stage_id: "review",
            status: "waiting_for_input",
            readiness: "waiting",
            layer: 0,
            layer_order: 0,
          },
        ],
        edges: [],
      },
    });
    expect(listWaitingHeader(detail)).toBe("Waiting on you: review");
  });

  it("includes waits-on copy on blocked rows", () => {
    const detail = run({
      stages: [
        {
          stage_id: "test",
          status: "pending",
          events: [],
          envelope: null,
          artifacts: [],
          attempt_count: 1,
        },
      ],
      pipeline_track: {
        nodes: [
          {
            stage_id: "test",
            status: "pending",
            readiness: "blocked",
            layer: 1,
            layer_order: 0,
            blocked_by: ["review"],
          },
        ],
        edges: [],
      },
    });
    const { detailListRows } = buildRunTrackView(detail, [], null);
    expect(detailListRows[0]?.readiness).toBe("blocked");
    expect(detailListRows[0]?.readinessLine).toBe("waits on review");
  });
});
