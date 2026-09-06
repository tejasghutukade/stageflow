import { describe, expect, it } from "vitest";
import { projectRun } from "../src/projection/projectRun.js";
import type {
  FeedbackLoopRecord,
  RunDetail,
  StageSnapshot,
} from "../src/runstore/port.js";

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id" | "status">,
): StageSnapshot {
  return {
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

const loop: FeedbackLoopRecord = {
  run_id: "run-1",
  loop_id: "loop-1",
  source_stage_id: "review",
  source_attempt: 2,
  policy: {
    target: "implement",
    max_replays: 1,
    on_max_replays: "wait_for_human",
    replay_session: "resume",
  },
  state: "waiting_for_human",
  deferred_send_back: {
    target: "implement",
    feedback_envelope: {
      status: "success",
      summary: "send-back",
      artifacts: [],
      feedback_loop: { action: "send_back", target: "implement" },
    },
    source_attempt: 2,
  },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "feedback-loop-wait-human",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    task_yaml: "id: t\ngoal: g\n",
    stages: [
      stage({ stage_id: "review", status: "waiting_for_input" }),
    ],
    pipeline_track: { nodes: [], edges: [] },
    waiting_stage_id: "review",
    waiting_stage_ids: ["review"],
    waiting_kind: "feedback_loop_decision",
    waiting_summary:
      "Feedback loop limit reached — extend, continue, or abandon",
    active_feedback_loop: loop,
    feedback_loops: [{ loop, replays: [], fork_generations: [] }],
    ...overrides,
  };
}

describe("projectRun feedback loop fields", () => {
  it("mirrors active_feedback_loop and feedback_loops", () => {
    const projected = projectRun(detail());
    expect(projected.active_feedback_loop).toEqual(loop);
    expect(projected.feedback_loops).toHaveLength(1);
    expect(projected.feedback_loops[0]?.loop.loop_id).toBe("loop-1");
    expect(projected.waiting_kind).toBe("feedback_loop_decision");
  });

  it("omits active_feedback_loop when absent but keeps feedback_loops", () => {
    const projected = projectRun(
      detail({
        active_feedback_loop: undefined,
        feedback_loops: [],
        waiting_kind: undefined,
        waiting_summary: undefined,
        waiting_stage_id: undefined,
        waiting_stage_ids: undefined,
        stages: [stage({ stage_id: "review", status: "succeeded" })],
      }),
    );
    expect(projected).not.toHaveProperty("active_feedback_loop");
    expect(projected.feedback_loops).toEqual([]);
  });
});
