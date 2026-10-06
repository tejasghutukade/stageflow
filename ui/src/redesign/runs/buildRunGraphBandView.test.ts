import { describe, expect, it } from "vitest";
import type { RunDetail } from "../../api";
import { buildRunGraphBandView } from "./buildRunGraphBandView";

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

describe("buildRunGraphBandView", () => {
  it("shows blocked tag and waits-on copy", () => {
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
    const nodes = buildRunGraphBandView(detail, [], null);
    expect(nodes[0]?.blocked).toBe(true);
    expect(nodes[0]?.readinessLine).toBe("Blocked");
    expect(nodes[0]?.waitsLine).toBe("waits on review");
    expect(nodes[0]?.clickable).toBe(false);
  });

  it("orders nodes by pipeline track layers", () => {
    const detail = run({
      pipeline_track: {
        nodes: [
          {
            stage_id: "b",
            status: "pending",
            readiness: "ready",
            layer: 1,
            layer_order: 0,
          },
          {
            stage_id: "a",
            status: "succeeded",
            readiness: "succeeded",
            layer: 0,
            layer_order: 0,
          },
        ],
        edges: [{ from: "a", to: "b" }],
      },
    });
    const nodes = buildRunGraphBandView(
      detail,
      [
        {
          id: "a",
          label: "a",
          status: "succeeded",
          selected: false,
          envelope: null,
        },
        {
          id: "b",
          label: "b",
          status: "pending",
          selected: false,
          envelope: null,
        },
      ],
      null,
    );
    expect(nodes.map((n) => n.stageId)).toEqual(["a", "b"]);
  });
});
