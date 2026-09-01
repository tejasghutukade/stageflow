import { describe, expect, it } from "vitest";
import type { RunDetail, StageSnapshot } from "../api";
import { resolveStreamRoute, type StreamRouteInput } from "./resolveStreamRoute";

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id">,
): StageSnapshot {
  return {
    status: "pending",
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

function runWith(stages: StageSnapshot[]): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    task_yaml: "goal: test",
    stages,
    pipeline_track: { nodes: [], edges: [] },
  };
}

function input(overrides: Partial<StreamRouteInput> = {}): StreamRouteInput {
  return {
    view: { kind: "stream" },
    streamViewStageId: undefined,
    run: runWith([stage({ stage_id: "design", status: "running" })]),
    plannedStageIds: [],
    selectedStageId: null,
    syncStreamRoute: false,
    userPickedStageId: null,
    dismissedWaitKey: null,
    ...overrides,
  };
}

describe("resolveStreamRoute", () => {
  it("opens the selected stream when syncStreamRoute is set", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "artifact", path: "plan.md" },
          selectedStageId: "review",
          syncStreamRoute: true,
        }),
      ),
    ).toEqual({ action: "openStream", stageId: "review" });
  });

  it("opens stream without a stage when the artifact wait ends with no selection", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "artifact", path: "plan.md" },
          syncStreamRoute: true,
          selectedStageId: null,
        }),
      ),
    ).toEqual({ action: "openStream", stageId: undefined });
  });

  it("bounces an unknown stream deep-link", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream", stageId: "ghost" },
          streamViewStageId: "ghost",
          userPickedStageId: "ghost",
        }),
      ),
    ).toEqual({ action: "openStream" });
  });

  it("keeps a planned pending stageId", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream", stageId: "review" },
          streamViewStageId: "review",
          plannedStageIds: ["design", "review"],
          selectedStageId: "review",
          userPickedStageId: "review",
        }),
      ),
    ).toEqual({ action: "none" });
  });

  it("writes the auto-selected wait into the stream route", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream" },
          selectedStageId: "clarify",
        }),
      ),
    ).toEqual({ action: "openStream", stageId: "clarify" });
  });

  it("does not rewrite when the URL already matches the selected stage", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream", stageId: "design" },
          streamViewStageId: "design",
          selectedStageId: "design",
        }),
      ),
    ).toEqual({ action: "none" });
  });

  it("does not rewrite after Hide workspace while the wait is dismissed", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream" },
          selectedStageId: "clarify",
          dismissedWaitKey: "clarify:p-ft",
        }),
      ),
    ).toEqual({ action: "none" });
  });

  it("does not rewrite when the operator picked a stage", () => {
    expect(
      resolveStreamRoute(
        input({
          view: { kind: "stream" },
          selectedStageId: "clarify",
          userPickedStageId: "design",
        }),
      ),
    ).toEqual({ action: "none" });
  });

  it("does nothing without a run", () => {
    expect(resolveStreamRoute(input({ run: null, selectedStageId: "design" }))).toEqual({
      action: "none",
    });
  });
});
