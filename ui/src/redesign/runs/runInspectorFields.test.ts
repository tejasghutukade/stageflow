import { describe, expect, it } from "vitest";
import type { RunDetail, StageSnapshot } from "../../api";
import {
  pendingGateLabel,
  retryBlockedByAnswerGate,
  stageReadinessLabel,
} from "./runInspectorFields";

function stage(partial: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id">): StageSnapshot {
  return {
    status: "pending",
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...partial,
  };
}

function run(partial: Partial<RunDetail>): RunDetail {
  return {
    run_id: "run_1",
    pipeline_id: "p",
    status: "running",
    created_at: "2026-01-01T00:00:00Z",
    stages: [],
    task_yaml: "",
    binding: { kind: "unbound" },
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
    ...partial,
  } as RunDetail;
}

describe("pendingGateLabel", () => {
  it("labels confirm prompts", () => {
    expect(
      pendingGateLabel({ kind: "confirm", id: "p1", message: "OK?" }),
    ).toBe("confirm gate");
  });
});

describe("stageReadinessLabel", () => {
  it("uses blocked_by from pipeline track", () => {
    const r = run({
      pipeline_track: {
        nodes: [
          {
            stage_id: "test",
            status: "pending",
            readiness: "blocked",
            blocked_by: ["review"],
            layer: 1,
            layer_order: 0,
          },
        ],
        edges: [],
      },
      stages: [stage({ stage_id: "test", status: "pending" })],
    });
    expect(stageReadinessLabel(r, r.stages[0]!)).toBe("Blocked on review");
  });
});

describe("retryBlockedByAnswerGate", () => {
  it("is true when run waits on an operator gate", () => {
    expect(
      retryBlockedByAnswerGate(
        run({ waiting_stage_id: "review", waiting_kind: "confirm" }),
      ),
    ).toBe(true);
  });

  it("is false for feedback loop decisions", () => {
    expect(
      retryBlockedByAnswerGate(
        run({
          waiting_stage_id: "plan",
          waiting_kind: "feedback_loop_decision",
        }),
      ),
    ).toBe(false);
  });
});
