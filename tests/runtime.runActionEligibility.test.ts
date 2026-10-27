import { describe, expect, it } from "vitest";
import {
  assertStageRetryEligible,
  canAbandonStage,
  canCancelRun,
  canRetryStage,
  resumesRunOnStageRetry,
  runActionEligibility,
  succeededStageRetryBlocker,
} from "../src/runtime/runActionEligibility.js";
import { isRunClockTerminal } from "../src/runstore/runStatusClock.js";
import type { RunDetail } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";

function stage(
  overrides: Partial<RunDetail["stages"][number]> & { stage_id?: string } = {},
): RunDetail["stages"][number] {
  return {
    stage_id: overrides.stage_id ?? "design-doc",
    status: overrides.status ?? "failed",
    events: overrides.events ?? [],
    envelope: overrides.envelope ?? null,
    artifacts: overrides.artifacts ?? [],
    attempt_count: overrides.attempt_count ?? 1,
    ...(overrides.definition_id !== undefined
      ? { definition_id: overrides.definition_id }
      : {}),
  };
}

function detail(
  runStatus: RunDetail["status"],
  stages: RunDetail["stages"],
): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "pipe",
    status: runStatus,
    created_at: "2026-01-01T00:00:00.000Z",
    binding: { kind: "unbound" },
    task_yaml: "",
    stages,
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
  };
}

describe("resumesRunOnStageRetry", () => {
  it("matches the run reopen clock terminal set", () => {
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(resumesRunOnStageRetry(status)).toBe(true);
      expect(isRunClockTerminal(status)).toBe(true);
    }
    expect(resumesRunOnStageRetry("running")).toBe(false);
  });
});

describe("canCancelRun / canAbandonStage", () => {
  it("allows cancel for non-succeeded/failed runs", () => {
    expect(canCancelRun("created")).toBe(true);
    expect(canCancelRun("queued")).toBe(true);
    expect(canCancelRun("running")).toBe(true);
    expect(canCancelRun("cancelled")).toBe(true);
    expect(canCancelRun("succeeded")).toBe(false);
    expect(canCancelRun("failed")).toBe(false);
  });

  it("allows abandon only while the stage is running", () => {
    expect(canAbandonStage("running")).toBe(true);
    expect(canAbandonStage("failed")).toBe(false);
    expect(canAbandonStage("waiting_for_input")).toBe(false);
  });
});

describe("succeededStageRetryBlocker", () => {
  it("blocks clone instances and recorded fork choices", () => {
    expect(
      succeededStageRetryBlocker(
        stage({ stage_id: "design-doc#1", definition_id: "design-doc", status: "succeeded" }),
      ),
    ).toMatch(/clone instance/i);
    const forkEnvelope: StageEnvelope = {
      status: "success",
      summary: "fork",
      artifacts: [],
      fork_choice: ["branch-a"],
    };
    expect(
      succeededStageRetryBlocker(
        stage({ status: "succeeded", envelope: forkEnvelope }),
      ),
    ).toMatch(/fork_choice/i);
    expect(
      succeededStageRetryBlocker(stage({ status: "succeeded" })),
    ).toBeUndefined();
  });
});

describe("runActionEligibility", () => {
  it("projects retry, cancel, and abandon with blockers", () => {
    const failed = stage({ status: "failed" });
    expect(
      runActionEligibility({
        runStatus: "failed",
        stage: failed,
        stages: [failed],
      }),
    ).toEqual({
      canRetry: true,
      canCancel: false,
      canAbandon: false,
      blockers: ["Run is failed and cannot be cancelled", "Stage is not running (status=failed)"],
    });

    const running = stage({ status: "running" });
    expect(
      runActionEligibility({
        runStatus: "running",
        stage: running,
        stages: [running],
      }),
    ).toMatchObject({
      canRetry: false,
      canCancel: true,
      canAbandon: true,
    });

    const succeeded = stage({ status: "succeeded" });
    expect(
      canRetryStage({
        runStatus: "succeeded",
        stage: succeeded,
        stages: [succeeded],
      }),
    ).toBe(true);
  });
});

describe("assertStageRetryEligible", () => {
  it("delegates to the eligibility module", () => {
    expect(
      assertStageRetryEligible(
        detail("cancelled", [stage({ status: "failed" })]),
        "design-doc",
      ),
    ).toEqual({ ok: true });
    expect(
      assertStageRetryEligible(
        detail("failed", [stage({ status: "waiting_for_input" })]),
        "design-doc",
      ),
    ).toMatchObject({ ok: false, code: "hitl_not_retriable", status: 409 });
  });
});
