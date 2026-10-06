import { describe, expect, it } from "vitest";
import type { RunDetail } from "../api";
import {
  findStageTrackNode,
  isTimelineBlockedStage,
  stageTimelineSubline,
} from "./stageTrackNode";

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

describe("stageTrackNode", () => {
  it("finds track node by stage id", () => {
    const detail = run({
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
    expect(findStageTrackNode(detail, "test")?.readiness).toBe("blocked");
  });

  it("marks pending blocked stages for timeline", () => {
    const node = findStageTrackNode(
      run({
        pipeline_track: {
          nodes: [
            {
              stage_id: "ship",
              status: "pending",
              readiness: "blocked",
              layer: 2,
              layer_order: 0,
            },
          ],
          edges: [],
        },
      }),
      "ship",
    );
    const stage = {
      stage_id: "ship",
      status: "pending" as const,
      events: [],
      envelope: null,
      artifacts: [],
      attempt_count: 1,
    };
    expect(isTimelineBlockedStage(stage, node)).toBe(true);
    expect(stageTimelineSubline(stage, node)).toBe("Blocked");
  });
});
