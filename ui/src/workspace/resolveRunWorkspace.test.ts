import { describe, expect, it } from "vitest";
import type { PendingPrompt, PipelineTrackNode, RunDetail, StageSnapshot } from "../api";
import type { DetailView } from "../routes";
import { statusCopy } from "../status/runStatus";
import { formatEnvelopeSubtitle } from "../components/EnvelopeFields";
import { spatialNodeKicker } from "../components/SpatialRunMap";
import {
  envelopeAsidePath,
  formatCloneLabel,
  parseEnvelopeAsidePath,
  resolveRunWorkspace,
  runDetailShouldPoll,
  stageCloneLabel,
  stageIdKnown,
  type OperatorSelection,
} from "./resolveRunWorkspace";

const stream: DetailView = { kind: "stream" };
const artifactView: DetailView = { kind: "artifact", path: "plan.md" };

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

function detail(
  stages: StageSnapshot[],
  overrides: Partial<RunDetail> = {},
): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "pipe",
    status: "running",
    created_at: "2026-08-18T00:00:00.000Z",
    task_yaml: "goal: test",
    stages,
    pipeline_track: { nodes: [], edges: [] },
    ...overrides,
  };
}

function selection(
  overrides: Partial<OperatorSelection> = {},
): OperatorSelection {
  return {
    previousStageId: null,
    userPicked: false,
    drawerStageId: null,
    dismissedWaitKey: null,
    ...overrides,
  };
}

const freeText: PendingPrompt = {
  kind: "free_text",
  id: "p-ft",
  message: "What should we do?",
};

const artifactPrompt: PendingPrompt = {
  kind: "artifact_backed",
  id: "p-ab",
  message: "Review the plan",
  artifacts: ["plan.md"],
};

const envelope = {
  status: "success",
  summary: "handoff",
  artifacts: ["out.md"],
};

describe("stage selection", () => {
  it("stream view with no pick and no wait is empty", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "review", status: "succeeded" }),
    ]);
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.kind).toBe("empty");
  });

  it("does not auto-select a running-only stream", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "build", status: "running" }),
      stage({ stage_id: "review", status: "pending" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBeNull();
  });

  it("does not auto-select a failed-only stream", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "build", status: "failed" }),
      stage({ stage_id: "review", status: "pending" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBeNull();
  });

  it("does not keep a previous stage without a user pick", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "review", status: "succeeded" }),
    ]);
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ previousStageId: "review" }),
      ).selectedStageId,
    ).toBeNull();
  });

  it("selects waiting_stage_id when the wait is not dismissed", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
        stage({
          stage_id: "review",
          status: "waiting_for_input",
          pending_prompt: { kind: "confirm", id: "p-cf", message: "OK?" },
        }),
      ],
      { waiting_stage_id: "review" },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.selectedStageId).toBe("review");
    expect(workspace.kind).toBe("stream");
    expect(workspace.composer).toEqual({
      kind: "reply",
      prompt: { kind: "confirm", id: "p-cf", message: "OK?" },
    });
  });

  it("stays empty after Hide workspace while the same wait is open", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
      ],
      { waiting_stage_id: "clarify" },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ dismissedWaitKey: "clarify:p-ft" }),
    );
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.kind).toBe("empty");
  });

  it("selects a new wait after a dismissed key", () => {
    const run = detail(
      [
        stage({
          stage_id: "review",
          status: "waiting_for_input",
          pending_prompt: { kind: "confirm", id: "p-cf", message: "OK?" },
        }),
      ],
      { waiting_stage_id: "review" },
    );
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ dismissedWaitKey: "clarify:p-ft" }),
      ).selectedStageId,
    ).toBe("review");
  });

  it("falls back to waiting_prompt_id when the waiter has no snapshot prompt", () => {
    const run = detail(
      [stage({ stage_id: "clarify", status: "waiting_for_input" })],
      { waiting_stage_id: "clarify", waiting_prompt_id: "p-run" },
    );
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("clarify");
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ dismissedWaitKey: "p-run" }),
      ).selectedStageId,
    ).toBeNull();
  });

  it("selects the artifact owner and keeps artifact kind", () => {
    const run = detail([
      stage({
        stage_id: "intake",
        status: "succeeded",
        artifacts: ["notes.md"],
      }),
      stage({
        stage_id: "design",
        status: "succeeded",
        artifacts: ["plan.md"],
      }),
    ]);
    const workspace = resolveRunWorkspace(artifactView, run, selection());
    expect(workspace.selectedStageId).toBe("design");
    expect(workspace.kind).toBe("artifact");
  });

  it("keeps artifact kind when no snapshot owns the path", () => {
    const run = detail([
      stage({ stage_id: "design", status: "succeeded", artifacts: ["other.md"] }),
    ]);
    const workspace = resolveRunWorkspace(artifactView, run, selection());
    expect(workspace.kind).toBe("artifact");
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.selectedPath).toBe("plan.md");
  });

  it("selects a stream stageId from the view", () => {
    const run = detail([
      stage({ stage_id: "design", status: "running" }),
      stage({ stage_id: "review", status: "pending" }),
    ]);
    const workspace = resolveRunWorkspace(
      { kind: "stream", stageId: "design" },
      run,
      selection(),
    );
    expect(workspace.selectedStageId).toBe("design");
    expect(workspace.kind).toBe("stream");
  });

  it("ignores an unknown stream stageId and stays map-only", () => {
    const run = detail([stage({ stage_id: "design", status: "running" })]);
    const workspace = resolveRunWorkspace(
      { kind: "stream", stageId: "ghost" },
      run,
      selection(),
    );
    expect(stageIdKnown(run, "ghost")).toBe(false);
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.kind).toBe("empty");
  });

  it("opens stream workspace for a pending planned stageId", () => {
    const run = detail([stage({ stage_id: "design", status: "running" })]);
    const workspace = resolveRunWorkspace(
      { kind: "stream", stageId: "review" },
      run,
      selection(),
      ["design", "review"],
    );
    expect(workspace.selectedStageId).toBe("review");
    expect(workspace.kind).toBe("stream");
    expect(workspace.composer).toEqual({ kind: "idle", label: "Session closed" });
  });

  it("selects the envelope route stage without a user pick", () => {
    const run = detail([
      stage({ stage_id: "clarify", status: "succeeded", envelope }),
      stage({ stage_id: "review", status: "running" }),
    ]);
    const workspace = resolveRunWorkspace(
      { kind: "envelope", stageId: "clarify" },
      run,
      selection(),
    );
    expect(workspace.selectedStageId).toBe("clarify");
    expect(workspace.kind).toBe("envelope");
  });

  it("preserves a user pick of a running clone when a sibling is waiting", () => {
    const run = detail(
      [
        stage({ stage_id: "clarify", status: "waiting_for_input" }),
        stage({ stage_id: "review", status: "running" }),
      ],
      { waiting_stage_id: "clarify" },
    );
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ previousStageId: "review", userPicked: true }),
      ).selectedStageId,
    ).toBe("review");
  });

  it("clears a HITL-only pick when the wait ends", () => {
    const run = detail([
      stage({ stage_id: "clarify", status: "succeeded" }),
      stage({ stage_id: "review", status: "running" }),
    ]);
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ previousStageId: "clarify", userPicked: false }),
      ).selectedStageId,
    ).toBeNull();
  });

  it("drops an operator pick when the stage no longer exists and edge-triggers the waiter", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
        stage({ stage_id: "review", status: "pending" }),
      ],
      { waiting_stage_id: "clarify" },
    );
    expect(
      resolveRunWorkspace(
        stream,
        run,
        selection({ previousStageId: "gone", userPicked: true }),
      ).selectedStageId,
    ).toBe("clarify");
  });

  it("resolves an artifact owner from envelope artifacts in track order", () => {
    const run = detail([
      stage({
        stage_id: "design",
        status: "succeeded",
        envelope: { ...envelope, artifacts: ["plan.md"] },
      }),
      stage({
        stage_id: "review",
        status: "succeeded",
        artifacts: ["plan.md"],
      }),
    ]);
    expect(
      resolveRunWorkspace(artifactView, run, selection()).selectedStageId,
    ).toBe("design");
  });
});

describe("composer and session chip", () => {
  it("stream + waiting + pending_prompt returns a composer that accepts a reply", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
      ],
      { waiting_stage_id: "clarify" },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.kind).toBe("stream");
    expect(workspace.composer).toEqual({ kind: "reply", prompt: freeText });
    expect(workspace.sessionChip).toBe("alive");
  });

  it("stream + succeeded, failed, or pending returns session-closed idle and no composer", () => {
    for (const status of ["succeeded", "failed", "pending"] as const) {
      const run = detail([stage({ stage_id: "done", status })]);
      const workspace = resolveRunWorkspace(
        stream,
        run,
        selection({ previousStageId: "done", userPicked: true }),
      );
      expect(workspace.composer).toEqual({
        kind: "idle",
        label: "Session closed",
      });
      expect(workspace.sessionChip).toBe("closed");
    }
  });

  it("running stream omits the idle composer and session chip", () => {
    const run = detail([stage({ stage_id: "build", status: "running" })]);
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.composer).toEqual({ kind: "none" });
    expect(workspace.sessionChip).toBeNull();
  });
});

describe("artifact workspace", () => {
  it("artifact + waiting artifact_backed shows decide and an editable reader", () => {
    const run = detail(
      [
        stage({
          stage_id: "review",
          status: "waiting_for_input",
          pending_prompt: artifactPrompt,
          artifacts: ["plan.md"],
        }),
      ],
      { waiting_stage_id: "review" },
    );
    const workspace = resolveRunWorkspace(artifactView, run, selection());
    expect(workspace.kind).toBe("artifact");
    expect(workspace.showDecide).toBe(true);
    expect(workspace.artifactReadOnly).toBe(false);
    expect(workspace.selectedPath).toBe("plan.md");
    expect(workspace.decidePrompt).toEqual(artifactPrompt);
  });

  it("artifact + not waiting is read-only with no decide", () => {
    const run = detail([
      stage({
        stage_id: "review",
        status: "succeeded",
        artifacts: ["plan.md"],
      }),
    ]);
    const workspace = resolveRunWorkspace(artifactView, run, selection());
    expect(workspace.kind).toBe("artifact");
    expect(workspace.showDecide).toBe(false);
    expect(workspace.artifactReadOnly).toBe(true);
    expect(workspace.decidePrompt).toBeUndefined();
  });

  it("returns stream when the artifact prompt clears while the artifact route is active", () => {
    const run = detail([
      stage({
        stage_id: "review",
        status: "running",
        artifacts: ["plan.md"],
      }),
    ]);
    const workspace = resolveRunWorkspace(
      artifactView,
      run,
      selection({ wasWaitingArtifact: true }),
    );
    expect(workspace.kind).toBe("stream");
    expect(workspace.showDecide).toBe(false);
    expect(workspace.syncStreamRoute).toBe(true);
  });
});

describe("drawer arbitration", () => {
  it("envelope route wins over an open drawer", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
      }),
      stage({
        stage_id: "review",
        status: "succeeded",
        envelope,
      }),
    ]);
    const workspace = resolveRunWorkspace(
      { kind: "envelope", stageId: "review" },
      run,
      selection({ drawerStageId: "clarify" }),
    );
    expect(workspace.kind).toBe("envelope");
    expect(workspace.drawer).toBeNull();
    expect(workspace.activeEnvelopeId).toBe("review");
    expect(workspace.envelope).toEqual({
      fromStageId: "review",
      toStageId: undefined,
      envelope,
    });
  });

  it("returns no drawer when the target stage has no envelope", () => {
    const run = detail([
      stage({ stage_id: "clarify", status: "succeeded" }),
      stage({ stage_id: "review", status: "running" }),
    ]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ drawerStageId: "clarify" }),
    );
    expect(workspace.drawer).toBeNull();
  });

  it("drawer target is the next stage, and none for the last", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
      }),
      stage({
        stage_id: "review",
        status: "succeeded",
        envelope,
      }),
    ]);
    const mid = resolveRunWorkspace(
      stream,
      run,
      selection({ drawerStageId: "clarify" }),
    );
    expect(mid.drawer).toEqual({
      fromStageId: "clarify",
      toStageId: "review",
      envelope,
    });

    const last = resolveRunWorkspace(
      stream,
      run,
      selection({ drawerStageId: "review" }),
    );
    expect(last.drawer).toEqual({
      fromStageId: "review",
      toStageId: undefined,
      envelope,
    });
  });
});

describe("track stages", () => {
  it("marks the selected stage and uses statusCopy for waiting meta", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          last_at: "2026-08-18T01:00:00.000Z",
        }),
        stage({
          stage_id: "review",
          status: "pending",
          last_at: "2026-08-18T02:00:00.000Z",
        }),
      ],
      { waiting_stage_id: "clarify" },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.trackStages).toEqual([
      {
        id: "clarify",
        label: "clarify",
        status: "waiting",
        selected: true,
        meta: statusCopy("waiting_for_input"),
        envelope: null,
      },
      {
        id: "review",
        label: "review",
        status: "pending",
        selected: false,
        meta: "2026-08-18T02:00:00.000Z",
        envelope: null,
      },
    ]);
  });

  it("pads not-yet-run planned stages as pending", () => {
    const run = detail([stage({ stage_id: "a", status: "running" })]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection(),
      ["a", "b", "c"],
    );
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.trackStages).toEqual([
      {
        id: "a",
        label: "a",
        status: "running",
        selected: false,
        meta: undefined,
        envelope: null,
      },
      {
        id: "b",
        label: "b",
        status: "pending",
        selected: false,
        meta: "pending",
        envelope: null,
      },
      {
        id: "c",
        label: "c",
        status: "pending",
        selected: false,
        meta: "pending",
        envelope: null,
      },
    ]);
  });

  it("reorders live snapshots into planned YAML order", () => {
    const run = detail([
      stage({ stage_id: "implement", status: "running" }),
      stage({ stage_id: "plan-review", status: "succeeded" }),
    ]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection(),
      ["plan-review", "implement"],
    );
    expect(workspace.trackStages.map((s) => s.id)).toEqual([
      "plan-review",
      "implement",
    ]);
    expect(workspace.trackStages[0]?.status).toBe("succeeded");
    expect(workspace.trackStages[1]?.status).toBe("running");
  });

  it("shows all planned stages as pending when the run has none yet", () => {
    const run = detail([]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection(),
      ["a", "b"],
    );
    expect(workspace.kind).toBe("empty");
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.trackStages).toEqual([
      {
        id: "a",
        label: "a",
        status: "pending",
        selected: false,
        meta: "pending",
        envelope: null,
      },
      {
        id: "b",
        label: "b",
        status: "pending",
        selected: false,
        meta: "pending",
        envelope: null,
      },
    ]);
  });

  it("appends live stages that are missing from the planned list", () => {
    const run = detail([
      stage({ stage_id: "a", status: "running" }),
      stage({ stage_id: "orphan", status: "succeeded" }),
    ]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection(),
      ["a", "b"],
    );
    expect(workspace.trackStages.map((s) => s.id)).toEqual(["a", "b", "orphan"]);
  });

  it("does not select a planned placeholder that has no live snapshot", () => {
    const run = detail(
      [
        stage({
          stage_id: "clarify",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
      ],
      { waiting_stage_id: "clarify" },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "review", userPicked: true }),
      ["clarify", "review"],
    );
    expect(workspace.selectedStageId).toBe("clarify");
    expect(workspace.trackStages[1]?.selected).toBe(false);
  });

  it("names the next planned stage on an envelope even before it starts", () => {
    const run = detail([
      stage({
        stage_id: "a",
        status: "succeeded",
        envelope,
      }),
    ]);
    const drawer = resolveRunWorkspace(
      stream,
      run,
      selection({ drawerStageId: "a" }),
      ["a", "b"],
    );
    expect(drawer.drawer).toEqual({
      fromStageId: "a",
      toStageId: "b",
      envelope,
    });

    const record = resolveRunWorkspace(
      { kind: "envelope", stageId: "a" },
      run,
      selection(),
      ["a", "b"],
    );
    expect(record.envelope?.toStageId).toBe("b");
  });
});

function trackNode(
  overrides: Partial<PipelineTrackNode> & Pick<PipelineTrackNode, "stage_id">,
): PipelineTrackNode {
  return {
    status: "pending",
    readiness: "blocked",
    layer: 0,
    layer_order: 0,
    ...overrides,
  };
}

const fanOutTrack = {
  nodes: [
    trackNode({
      stage_id: "recon",
      status: "succeeded",
      readiness: "succeeded",
      layer: 0,
      layer_order: 0,
    }),
    trackNode({
      stage_id: "improve-a",
      status: "waiting_for_input",
      readiness: "waiting",
      layer: 1,
      layer_order: 0,
    }),
    trackNode({
      stage_id: "improve-b",
      status: "running",
      readiness: "running",
      layer: 1,
      layer_order: 1,
    }),
    trackNode({
      stage_id: "improve-c",
      status: "waiting_for_input",
      readiness: "waiting",
      layer: 1,
      layer_order: 2,
    }),
    trackNode({
      stage_id: "report-b",
      status: "pending",
      readiness: "blocked",
      layer: 2,
      layer_order: 1,
      blocked_by: ["improve-b"],
    }),
  ],
  edges: [
    { from: "recon", to: "improve-a" },
    { from: "recon", to: "improve-b" },
    { from: "recon", to: "improve-c" },
    { from: "improve-b", to: "report-b" },
  ],
};

describe("spatial track layout", () => {
  it("projects fan-out nodes and waiting chrome", () => {
    const run = detail(
      [
        stage({ stage_id: "recon", status: "succeeded" }),
        stage({
          stage_id: "improve-a",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
        stage({ stage_id: "improve-b", status: "running" }),
        stage({
          stage_id: "improve-c",
          status: "waiting_for_input",
          pending_prompt: { kind: "confirm", id: "p2", message: "OK?" },
        }),
        stage({ stage_id: "report-b", status: "pending" }),
      ],
      {
        pipeline_track: fanOutTrack,
        waiting_stage_ids: ["improve-a", "improve-c"],
        waiting_stage_id: "improve-a",
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.spatialLayout.nodes.map((n) => n.stageId)).toEqual([
      "recon",
      "improve-a",
      "improve-b",
      "improve-c",
      "report-b",
    ]);
    expect(workspace.spatialLayout.edges).toEqual(fanOutTrack.edges);
    expect(
      workspace.nodeChrome.filter((c) => c.isWaitingAttention).map((c) => c.stageId),
    ).toEqual(["improve-a", "improve-c"]);
    expect(workspace.selectedStageId).toBe("improve-a");
    expect(workspace.kind).toBe("stream");
  });

  it("resolves inbound envelope via DAG edges not declaration order", () => {
    const run = detail(
      [
        stage({ stage_id: "recon", status: "succeeded", envelope }),
        stage({ stage_id: "improve-b", status: "running", envelope }),
        stage({ stage_id: "report-b", status: "pending" }),
      ],
      { pipeline_track: fanOutTrack },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "report-b", userPicked: true }),
    );
    expect(workspace.inboundFromStageId).toBe("improve-b");
    expect(workspace.inboundEnvelope).toEqual(envelope);
  });

  it("shows blocked readiness on node chrome", () => {
    const run = detail(
      [
        stage({ stage_id: "improve-b", status: "running" }),
        stage({ stage_id: "report-b", status: "pending" }),
      ],
      { pipeline_track: fanOutTrack },
    );
    const chrome = resolveRunWorkspace(stream, run, selection()).nodeChrome.find(
      (c) => c.stageId === "report-b",
    );
    expect(chrome?.readinessLine).toBe("Blocked on improve-b");
  });

  it("passes attempt_count into node chrome", () => {
    const run = detail(
      [
        stage({ stage_id: "improve-b", status: "failed", attempt_count: 2 }),
        stage({ stage_id: "report-b", status: "pending" }),
      ],
      {
        pipeline_track: {
          nodes: [
            trackNode({
              stage_id: "improve-b",
              layer: 1,
              layer_order: 0,
              status: "failed",
              readiness: "failed",
            }),
            trackNode({
              stage_id: "report-b",
              layer: 2,
              layer_order: 0,
              status: "pending",
              readiness: "blocked",
              blocked_by: ["improve-b"],
            }),
          ],
          edges: [{ from: "improve-b", to: "report-b" }],
        },
      },
    );
    const chrome = resolveRunWorkspace(stream, run, selection()).nodeChrome.find(
      (c) => c.stageId === "improve-b",
    );
    expect(chrome?.attemptCount).toBe(2);
  });

  it("lays out a single-chain projection as a spatial row", () => {
    const run = detail(
      [
        stage({ stage_id: "a", status: "succeeded" }),
        stage({ stage_id: "b", status: "running" }),
        stage({ stage_id: "c", status: "pending" }),
      ],
      {
        pipeline_track: {
          nodes: [
            trackNode({ stage_id: "a", layer: 0, layer_order: 0, status: "succeeded", readiness: "succeeded" }),
            trackNode({ stage_id: "b", layer: 1, layer_order: 0, status: "running", readiness: "running" }),
            trackNode({ stage_id: "c", layer: 2, layer_order: 0, status: "pending", readiness: "blocked" }),
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
          ],
        },
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.spatialLayout.nodes.map((n) => n.stageId)).toEqual(["a", "b", "c"]);
    expect(workspace.spatialLayout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });
});

describe("formatCloneLabel", () => {
  it("returns stageId when definitionId is missing", () => {
    expect(formatCloneLabel("author-diagrams~1")).toBe("author-diagrams~1");
  });

  it("returns definitionId when stageId equals definitionId", () => {
    expect(formatCloneLabel("collect", "collect")).toBe("collect");
  });

  it("returns definition plus 1-based ordinal for fan-out instances", () => {
    expect(formatCloneLabel("author-diagrams~1", "author-diagrams", 1)).toBe(
      "author-diagrams · 1",
    );
  });
});

function cloneTrackNode(
  overrides: Partial<PipelineTrackNode> & Pick<PipelineTrackNode, "stage_id">,
): PipelineTrackNode {
  return {
    status: "pending",
    readiness: "blocked",
    layer: 0,
    layer_order: 0,
    ...overrides,
  };
}

const threeCloneTrack = {
  nodes: [
    cloneTrackNode({
      stage_id: "detect-changes",
      definition_id: "detect-changes",
      status: "succeeded",
      readiness: "succeeded",
      layer: 0,
      layer_order: 0,
    }),
    cloneTrackNode({
      stage_id: "author-diagrams~1",
      definition_id: "author-diagrams",
      status: "succeeded",
      readiness: "succeeded",
      layer: 1,
      layer_order: 0,
    }),
    cloneTrackNode({
      stage_id: "author-diagrams~2",
      definition_id: "author-diagrams",
      status: "waiting_for_input",
      readiness: "waiting",
      layer: 1,
      layer_order: 1,
    }),
    cloneTrackNode({
      stage_id: "author-diagrams~3",
      definition_id: "author-diagrams",
      status: "running",
      readiness: "running",
      layer: 1,
      layer_order: 2,
    }),
    cloneTrackNode({
      stage_id: "collect",
      definition_id: "collect",
      status: "pending",
      readiness: "blocked",
      layer: 2,
      layer_order: 0,
      blocked_by: ["author-diagrams~2", "author-diagrams~3"],
    }),
  ],
  edges: [
    { from: "detect-changes", to: "author-diagrams~1" },
    { from: "detect-changes", to: "author-diagrams~2" },
    { from: "detect-changes", to: "author-diagrams~3" },
    { from: "author-diagrams~1", to: "collect" },
    { from: "author-diagrams~2", to: "collect" },
    { from: "author-diagrams~3", to: "collect" },
  ],
};

describe("AE-console-nodes clone labels", () => {
  it("renders three clone nodes with definition-plus-index labels in dag mode", () => {
    const run = detail(
      [
        stage({ stage_id: "detect-changes", status: "succeeded" }),
        stage({ stage_id: "author-diagrams~1", status: "succeeded" }),
        stage({
          stage_id: "author-diagrams~2",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
        stage({ stage_id: "author-diagrams~3", status: "running" }),
        stage({ stage_id: "collect", status: "pending" }),
      ],
      {
        pipeline_track: threeCloneTrack,
        waiting_stage_id: "author-diagrams~1",
        waiting_stage_ids: ["author-diagrams~2"],
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(
      workspace.spatialLayout.nodes
        .filter((n) => n.layerIndex === 1)
        .map((n) => n.stageId),
    ).toEqual(["author-diagrams~1", "author-diagrams~2", "author-diagrams~3"]);
    expect(
      workspace.nodeChrome
        .filter((c) => c.kicker === "author-diagrams" && c.stageId !== "author-diagrams")
        .map((c) => c.title),
    ).toEqual(["author-diagrams · 1", "author-diagrams · 2", "author-diagrams · 3"]);
    expect(workspace.trackStages.find((s) => s.id === "detect-changes")?.label).toBe(
      "detect-changes",
    );
    expect(workspace.trackStages.find((s) => s.id === "collect")?.label).toBe(
      "collect",
    );
    const cloneChrome = workspace.nodeChrome.find((c) => c.stageId === "author-diagrams~2");
    expect(cloneChrome?.title).toBe("author-diagrams · 2");
    expect(cloneChrome?.kicker).toBe("author-diagrams");
    expect(spatialNodeKicker(cloneChrome!.kicker, cloneChrome!.title)).toBe(
      "author-diagrams",
    );

    const picked = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "author-diagrams~2", userPicked: true }),
    );
    expect(picked.selectedStageId).toBe("author-diagrams~2");
    expect(picked.trackStages.find((s) => s.selected)?.label).toBe(
      "author-diagrams · 2",
    );
  });

  it("joins clone chrome kicker against the ordinal title", () => {
    const run = detail(
      [
        stage({
          stage_id: "author-diagrams~2",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
      ],
      { pipeline_track: threeCloneTrack, waiting_stage_id: "author-diagrams~2" },
    );
    const chrome = resolveRunWorkspace(stream, run, selection()).nodeChrome.find(
      (c) => c.stageId === "author-diagrams~2",
    );
    expect(chrome).toEqual(
      expect.objectContaining({
        title: "author-diagrams · 2",
        kicker: "author-diagrams",
      }),
    );
    expect(spatialNodeKicker(chrome!.kicker, chrome!.title)).not.toBeNull();
  });

  it("labels a run-once author-diagrams node with the catalog id", () => {
    const run = detail(
      [
        stage({ stage_id: "detect-changes", status: "succeeded" }),
        stage({ stage_id: "author-diagrams", status: "running" }),
        stage({ stage_id: "collect", status: "pending" }),
      ],
      {
        pipeline_track: {
          nodes: [
            cloneTrackNode({
              stage_id: "detect-changes",
              definition_id: "detect-changes",
              layer: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
            cloneTrackNode({
              stage_id: "author-diagrams",
              definition_id: "author-diagrams",
              layer: 1,
              status: "running",
              readiness: "running",
            }),
            cloneTrackNode({
              stage_id: "collect",
              definition_id: "collect",
              layer: 2,
              status: "pending",
              readiness: "blocked",
            }),
          ],
          edges: [
            { from: "detect-changes", to: "author-diagrams" },
            { from: "author-diagrams", to: "collect" },
          ],
        },
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.spatialLayout.nodes.map((n) => n.stageId)).toEqual([
      "detect-changes",
      "author-diagrams",
      "collect",
    ]);
    expect(workspace.trackStages.find((s) => s.id === "author-diagrams")?.label).toBe(
      "author-diagrams",
    );
    const chrome = workspace.nodeChrome.find((c) => c.stageId === "author-diagrams");
    expect(chrome?.title).toBe("author-diagrams");
    expect(chrome?.kicker).toBe("author-diagrams");
    expect(spatialNodeKicker(chrome!.kicker, chrome!.title)).toBeNull();
  });
});

describe("AE-today-first-waiter clone waiters", () => {
  it("defaults to waiting_stage_id, sticks a user pick of ~2, and marks both waiters", () => {
    const run = detail(
      [
        stage({
          stage_id: "author-diagrams~1",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
        stage({
          stage_id: "author-diagrams~2",
          status: "waiting_for_input",
          pending_prompt: { kind: "confirm", id: "p2", message: "OK?" },
        }),
      ],
      {
        pipeline_track: {
          nodes: [
            cloneTrackNode({
              stage_id: "author-diagrams~1",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 0,
              status: "waiting_for_input",
              readiness: "waiting",
            }),
            cloneTrackNode({
              stage_id: "author-diagrams~2",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 1,
              status: "waiting_for_input",
              readiness: "waiting",
            }),
          ],
          edges: [],
        },
        waiting_stage_id: "author-diagrams~1",
        waiting_stage_ids: ["author-diagrams~1", "author-diagrams~2"],
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.selectedStageId).toBe("author-diagrams~1");
    expect(workspace.kind).toBe("stream");
    expect(
      workspace.nodeChrome.filter((c) => c.isWaitingAttention).map((c) => c.stageId),
    ).toEqual(["author-diagrams~1", "author-diagrams~2"]);

    const picked = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "author-diagrams~2", userPicked: true }),
    );
    expect(picked.selectedStageId).toBe("author-diagrams~2");
  });
});

describe("AE-skipped-leftovers", () => {
  it("shows sequential leftover clones as selectable skipped inspect nodes", () => {
    const run = detail(
      [
        stage({ stage_id: "author-diagrams~1", status: "succeeded" }),
        stage({ stage_id: "author-diagrams~2", status: "failed" }),
        stage({ stage_id: "author-diagrams~3", status: "skipped" }),
      ],
      {
        pipeline_track: {
          nodes: [
            cloneTrackNode({
              stage_id: "author-diagrams~1",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
            cloneTrackNode({
              stage_id: "author-diagrams~2",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 1,
              status: "failed",
              readiness: "failed",
            }),
            cloneTrackNode({
              stage_id: "author-diagrams~3",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 2,
              status: "skipped",
              readiness: "skipped",
            }),
          ],
          edges: [],
        },
      },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "author-diagrams~3", userPicked: true }),
    );
    expect(workspace.trackStages.map((s) => s.id)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(workspace.selectedStageId).toBe("author-diagrams~3");
    expect(workspace.selectedStage?.status).toBe("skipped");
    expect(workspace.trackStages.find((s) => s.id === "author-diagrams~3")?.status).toBe(
      "skipped",
    );
    expect(workspace.composer).toEqual({ kind: "idle", label: "Session closed" });
    expect(workspace.sessionChip).toBe("closed");
  });
});

describe("aside and envelope clone labels", () => {
  it("uses definition · N for clone artifact meta", () => {
    const run = detail(
      [
        stage({
          stage_id: "work~1",
          status: "succeeded",
          artifacts: ["out.md"],
        }),
      ],
      {
        pipeline_track: {
          nodes: [
            cloneTrackNode({
              stage_id: "work~1",
              definition_id: "work",
              layer: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
          ],
          edges: [],
        },
      },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "work~1", userPicked: true }),
    );
    expect(stageCloneLabel(run, "work~1")).toBe("work · 1");
    expect(workspace.artifactFiles).toEqual([
      { path: "out.md", meta: "work · 1" },
    ]);
  });

  it("keeps a non-clone stage meta without an ordinal", () => {
    const run = detail(
      [
        stage({
          stage_id: "design",
          status: "succeeded",
          artifacts: ["plan.md"],
        }),
      ],
      {
        pipeline_track: {
          nodes: [
            cloneTrackNode({
              stage_id: "design",
              definition_id: "design",
              layer: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
          ],
          edges: [],
        },
      },
    );
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "design", userPicked: true }),
    );
    expect(workspace.artifactFiles[0]?.meta).toBe("design");
  });

  it("joins two formatted envelope labels with an arrow", () => {
    expect(
      formatEnvelopeSubtitle("work~1", "collect", (id) =>
        id === "work~1" ? "work · 1" : "collect",
      ),
    ).toBe("work · 1 → collect");
  });
});

describe("handoff envelope aside", () => {
  it("prepends a Handoff envelope row when the selected stage has an envelope", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
        artifacts: ["notes.md"],
      }),
      stage({
        stage_id: "review",
        status: "running",
        artifacts: ["plan.md"],
      }),
    ]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "clarify", userPicked: true }),
    );
    expect(workspace.artifactFiles[0]).toEqual({
      path: envelopeAsidePath("clarify"),
      label: "Handoff envelope",
      meta: "clarify",
    });
    expect(workspace.artifactFiles.slice(1)).toEqual([
      { path: "notes.md", meta: "clarify" },
      { path: "plan.md", meta: "review" },
    ]);
  });

  it("omits the envelope row when the selected stage has no envelope", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
        artifacts: ["notes.md"],
      }),
      stage({
        stage_id: "review",
        status: "running",
        artifacts: ["plan.md"],
      }),
    ]);
    const workspace = resolveRunWorkspace(
      stream,
      run,
      selection({ previousStageId: "review", userPicked: true }),
    );
    expect(workspace.artifactFiles.every((f) => f.label !== "Handoff envelope")).toBe(
      true,
    );
    expect(workspace.artifactFiles).toEqual([
      { path: "notes.md", meta: "clarify" },
      { path: "plan.md", meta: "review" },
    ]);
  });

  it("selects the envelope sentinel while the envelope view is open", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
      }),
    ]);
    const workspace = resolveRunWorkspace(
      { kind: "envelope", stageId: "clarify" },
      run,
      selection(),
    );
    expect(workspace.kind).toBe("envelope");
    expect(workspace.selectedPath).toBe(envelopeAsidePath("clarify"));
  });

  it("focuses the envelope stage in Files when the envelope route is open", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "succeeded",
        envelope,
      }),
      stage({
        stage_id: "review",
        status: "running",
      }),
    ]);
    const workspace = resolveRunWorkspace(
      { kind: "envelope", stageId: "clarify" },
      run,
      selection({ previousStageId: "review", userPicked: true }),
    );
    expect(workspace.selectedStageId).toBe("clarify");
    expect(workspace.artifactFiles[0]).toEqual({
      path: envelopeAsidePath("clarify"),
      label: "Handoff envelope",
      meta: "clarify",
    });
    expect(workspace.selectedPath).toBe(envelopeAsidePath("clarify"));
  });

  it("parses envelope aside paths and rejects ordinary artifact paths", () => {
    expect(parseEnvelopeAsidePath(envelopeAsidePath("clarify"))).toBe("clarify");
    expect(parseEnvelopeAsidePath(envelopeAsidePath("author-diagrams~2"))).toBe(
      "author-diagrams~2",
    );
    expect(parseEnvelopeAsidePath("notes.md")).toBeNull();
    expect(parseEnvelopeAsidePath("stageflow:envelope:")).toBeNull();
    expect(parseEnvelopeAsidePath("stageflow:other:clarify")).toBeNull();
  });
});

describe("runDetailShouldPoll", () => {
  const idle = { retrying: false, abandoning: false };

  it("polls a failed run while a clone is still waiting", () => {
    const run = detail(
      [
        stage({ stage_id: "work~1", status: "failed" }),
        stage({
          stage_id: "work~2",
          status: "waiting_for_input",
          pending_prompt: freeText,
        }),
      ],
      { status: "failed", waiting_stage_id: "work~2" },
    );
    expect(runDetailShouldPoll(run, idle)).toBe(true);
  });

  it("polls a failed run while a retried clone is running", () => {
    const run = detail(
      [
        stage({ stage_id: "work~1", status: "failed" }),
        stage({ stage_id: "work~2", status: "running" }),
      ],
      { status: "failed" },
    );
    expect(runDetailShouldPoll(run, idle)).toBe(true);
  });

  it("stops polling when every stage has finished and nothing is retrying", () => {
    const run = detail(
      [
        stage({ stage_id: "work~1", status: "failed" }),
        stage({ stage_id: "work~2", status: "failed" }),
      ],
      { status: "failed" },
    );
    expect(runDetailShouldPoll(run, idle)).toBe(false);
    expect(runDetailShouldPoll(run, { retrying: true, abandoning: false })).toBe(
      true,
    );
  });
});
