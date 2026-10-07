import { describe, expect, it } from "vitest";
import type {
  FeedbackLoopHistory,
  FeedbackLoopRecord,
  PendingPrompt,
  PipelineTrackNode,
  RunDetail,
  StageSnapshot,
} from "../api";
import type { DetailView } from "../routes";
import {
  buildFeedbackOverlays,
  collectSupersededCloneStageIds,
  collectSupersededStageIds,
  envelopeAsidePath,
  formatCloneLabel,
  parseEnvelopeAsidePath,
  resolveFeedbackDecide,
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
    feedback_loops: [],
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
  it.each([
    {
      name: "succeeded stages, no pick, no wait",
      stages: [
        stage({ stage_id: "intake", status: "succeeded" }),
        stage({ stage_id: "review", status: "succeeded" }),
      ],
      sel: selection(),
    },
    {
      name: "running-only stream is not auto-selected",
      stages: [
        stage({ stage_id: "intake", status: "succeeded" }),
        stage({ stage_id: "build", status: "running" }),
        stage({ stage_id: "review", status: "pending" }),
      ],
      sel: selection(),
    },
    {
      name: "failed-only stream is not auto-selected",
      stages: [
        stage({ stage_id: "intake", status: "succeeded" }),
        stage({ stage_id: "build", status: "failed" }),
        stage({ stage_id: "review", status: "pending" }),
      ],
      sel: selection(),
    },
    {
      name: "previous stage is dropped without a user pick",
      stages: [
        stage({ stage_id: "intake", status: "succeeded" }),
        stage({ stage_id: "review", status: "succeeded" }),
      ],
      sel: selection({ previousStageId: "review" }),
    },
    {
      name: "HITL-only pick is cleared when the wait ends",
      stages: [
        stage({ stage_id: "clarify", status: "succeeded" }),
        stage({ stage_id: "review", status: "running" }),
      ],
      sel: selection({ previousStageId: "clarify", userPicked: false }),
    },
  ])("stream selects nothing: $name", ({ stages, sel }) => {
    const workspace = resolveRunWorkspace(stream, detail(stages), sel);
    expect(workspace.selectedStageId).toBeNull();
    expect(workspace.kind).toBe("empty");
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

  it.each([
    { dismissedWaitKey: "clarify:p-ft", selected: null, kind: "empty" },
    { dismissedWaitKey: "review:p-old", selected: "clarify", kind: "stream" },
  ] as const)(
    "wait dismissed with key $dismissedWaitKey selects $selected",
    ({ dismissedWaitKey, selected, kind }) => {
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
        selection({ dismissedWaitKey }),
      );
      expect(workspace.selectedStageId).toBe(selected);
      expect(workspace.kind).toBe(kind);
    },
  );

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
  it("marks the selected stage and shows the waiting copy as meta", () => {
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
        meta: "waiting on you",
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

  it.each([
    {
      name: "pads not-yet-run planned stages as pending",
      live: [stage({ stage_id: "a", status: "running" })],
      planned: ["a", "b", "c"],
      expected: [
        { id: "a", status: "running", meta: undefined },
        { id: "b", status: "pending", meta: "pending" },
        { id: "c", status: "pending", meta: "pending" },
      ],
    },
    {
      name: "shows all planned stages as pending when the run has none yet",
      live: [],
      planned: ["a", "b"],
      expected: [
        { id: "a", status: "pending", meta: "pending" },
        { id: "b", status: "pending", meta: "pending" },
      ],
    },
    {
      name: "reorders live snapshots into planned YAML order",
      live: [
        stage({ stage_id: "implement", status: "running" }),
        stage({ stage_id: "plan-review", status: "succeeded" }),
      ],
      planned: ["plan-review", "implement"],
      expected: [
        { id: "plan-review", status: "succeeded", meta: undefined },
        { id: "implement", status: "running", meta: undefined },
      ],
    },
    {
      name: "appends live stages missing from the planned list",
      live: [
        stage({ stage_id: "a", status: "running" }),
        stage({ stage_id: "orphan", status: "succeeded" }),
      ],
      planned: ["a", "b"],
      expected: [
        { id: "a", status: "running", meta: undefined },
        { id: "b", status: "pending", meta: "pending" },
        { id: "orphan", status: "succeeded", meta: undefined },
      ],
    },
  ])("track stages: $name", ({ live, planned, expected }) => {
    const workspace = resolveRunWorkspace(
      stream,
      detail(live),
      selection(),
      planned,
    );
    expect(workspace.selectedStageId).toBeNull();
    expect(
      workspace.trackStages.map(({ id, status, meta }) => ({ id, status, meta })),
    ).toEqual(expected);
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
});

describe("formatCloneLabel", () => {
  it.each([
    { args: ["author-diagrams~1"], label: "author-diagrams~1" },
    { args: ["author-diagrams~1", ""], label: "author-diagrams~1" },
    { args: ["collect", "collect"], label: "collect" },
    { args: ["collect", "collect", 2], label: "collect" },
    { args: ["author-diagrams~1", "author-diagrams"], label: "author-diagrams~1" },
    {
      args: ["author-diagrams~1", "author-diagrams", 1],
      label: "author-diagrams · 1",
    },
  ] as const)("$args -> $label", ({ args, label }) => {
    expect(
      formatCloneLabel(...(args as unknown as Parameters<typeof formatCloneLabel>)),
    ).toBe(label);
  });
});

const threeCloneTrack = {
  nodes: [
    trackNode({
      stage_id: "detect-changes",
      definition_id: "detect-changes",
      status: "succeeded",
      readiness: "succeeded",
      layer: 0,
      layer_order: 0,
    }),
    trackNode({
      stage_id: "author-diagrams~1",
      definition_id: "author-diagrams",
      status: "succeeded",
      readiness: "succeeded",
      layer: 1,
      layer_order: 0,
    }),
    trackNode({
      stage_id: "author-diagrams~2",
      definition_id: "author-diagrams",
      status: "waiting_for_input",
      readiness: "waiting",
      layer: 1,
      layer_order: 1,
    }),
    trackNode({
      stage_id: "author-diagrams~3",
      definition_id: "author-diagrams",
      status: "running",
      readiness: "running",
      layer: 1,
      layer_order: 2,
    }),
    trackNode({
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
  function threeCloneRun() {
    return detail(
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
  }

  it("renders three clone nodes with definition-plus-index titles in dag mode", () => {
    const workspace = resolveRunWorkspace(stream, threeCloneRun(), selection());
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
  });

  it("labels the picked clone's track stage with definition · N", () => {
    const picked = resolveRunWorkspace(
      stream,
      threeCloneRun(),
      selection({ previousStageId: "author-diagrams~2", userPicked: true }),
    );
    expect(picked.selectedStageId).toBe("author-diagrams~2");
    expect(picked.trackStages.find((s) => s.selected)?.label).toBe(
      "author-diagrams · 2",
    );
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
            trackNode({
              stage_id: "detect-changes",
              definition_id: "detect-changes",
              layer: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
            trackNode({
              stage_id: "author-diagrams",
              definition_id: "author-diagrams",
              layer: 1,
              status: "running",
              readiness: "running",
            }),
            trackNode({
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
    expect(workspace.trackStages.find((s) => s.id === "author-diagrams")?.label).toBe(
      "author-diagrams",
    );
    const chrome = workspace.nodeChrome.find((c) => c.stageId === "author-diagrams");
    expect(chrome?.title).toBe("author-diagrams");
    expect(chrome?.kicker).toBe("author-diagrams");
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
            trackNode({
              stage_id: "author-diagrams~1",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 0,
              status: "waiting_for_input",
              readiness: "waiting",
            }),
            trackNode({
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
            trackNode({
              stage_id: "author-diagrams~1",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 0,
              status: "succeeded",
              readiness: "succeeded",
            }),
            trackNode({
              stage_id: "author-diagrams~2",
              definition_id: "author-diagrams",
              layer: 0,
              layer_order: 1,
              status: "failed",
              readiness: "failed",
            }),
            trackNode({
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
  it.each([
    {
      name: "clone artifact meta uses definition · N",
      stageId: "work~1",
      definitionId: "work",
      path: "out.md",
      meta: "work · 1",
    },
    {
      name: "non-clone stage meta has no ordinal",
      stageId: "design",
      definitionId: "design",
      path: "plan.md",
      meta: "design",
    },
  ])("aside labels: $name", ({ stageId, definitionId, path, meta }) => {
    const run = detail(
      [stage({ stage_id: stageId, status: "succeeded", artifacts: [path] })],
      {
        pipeline_track: {
          nodes: [
            trackNode({
              stage_id: stageId,
              definition_id: definitionId,
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
      selection({ previousStageId: stageId, userPicked: true }),
    );
    expect(stageCloneLabel(run, stageId)).toBe(meta);
    expect(workspace.artifactFiles).toEqual([{ path, meta }]);
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
    expect(workspace.artifactFiles).toEqual([
      { path: "notes.md", meta: "clarify" },
      { path: "plan.md", meta: "review" },
    ]);
  });

  it.each([
    { name: "no pick", sel: selection() },
    {
      name: "another stage picked",
      sel: selection({ previousStageId: "review", userPicked: true }),
    },
  ])(
    "the envelope route selects the envelope stage and sentinel path ($name)",
    ({ sel }) => {
      const run = detail([
        stage({ stage_id: "clarify", status: "succeeded", envelope }),
        stage({ stage_id: "review", status: "running" }),
      ]);
      const workspace = resolveRunWorkspace(
        { kind: "envelope", stageId: "clarify" },
        run,
        sel,
      );
      expect(workspace.kind).toBe("envelope");
      expect(workspace.selectedStageId).toBe("clarify");
      expect(workspace.artifactFiles[0]).toEqual({
        path: envelopeAsidePath("clarify"),
        label: "Handoff envelope",
        meta: "clarify",
      });
      expect(workspace.selectedPath).toBe(envelopeAsidePath("clarify"));
    },
  );

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

  it.each([
    { name: "no run", run: null, action: idle, expected: false },
    { name: "no run but retrying", run: null, action: { ...idle, retrying: true }, expected: true },
    { name: "no run but abandoning", run: null, action: { ...idle, abandoning: true }, expected: true },
    { name: "created run", run: detail([], { status: "created" }), action: idle, expected: true },
    { name: "running run", run: detail([], { status: "running" }), action: idle, expected: true },
    {
      name: "failed run while a clone waits",
      run: detail(
        [
          stage({ stage_id: "work~1", status: "failed" }),
          stage({ stage_id: "work~2", status: "waiting_for_input", pending_prompt: freeText }),
        ],
        { status: "failed", waiting_stage_id: "work~2" },
      ),
      action: idle,
      expected: true,
    },
    {
      name: "failed run with only waiting_stage_id set",
      run: detail([stage({ stage_id: "work~1", status: "failed" })], {
        status: "failed",
        waiting_stage_id: "work~1",
      }),
      action: idle,
      expected: true,
    },
    {
      name: "failed run while a retried clone is running",
      run: detail(
        [
          stage({ stage_id: "work~1", status: "failed" }),
          stage({ stage_id: "work~2", status: "running" }),
        ],
        { status: "failed" },
      ),
      action: idle,
      expected: true,
    },
    {
      name: "failed run, all stages finished, idle",
      run: detail(
        [
          stage({ stage_id: "work~1", status: "failed" }),
          stage({ stage_id: "work~2", status: "failed" }),
        ],
        { status: "failed" },
      ),
      action: idle,
      expected: false,
    },
    {
      name: "failed run, all stages finished, retrying",
      run: detail([stage({ stage_id: "work~1", status: "failed" })], { status: "failed" }),
      action: { retrying: true, abandoning: false },
      expected: true,
    },
    {
      name: "succeeded run",
      run: detail([stage({ stage_id: "a", status: "succeeded" })], { status: "succeeded" }),
      action: idle,
      expected: false,
    },
  ])("$name -> $expected", ({ run, action, expected }) => {
    expect(runDetailShouldPoll(run, action)).toBe(expected);
  });
});

const feedbackEnvelope = {
  status: "needs_revision",
  summary: "send back",
  artifacts: [],
};

const T0 = "2026-08-18T00:00:00.000Z";

type ReplayEntry = FeedbackLoopHistory["replays"][number];
type ForkGeneration = FeedbackLoopHistory["fork_generations"][number];

function feedbackLoop(
  overrides: Partial<FeedbackLoopRecord> = {},
): FeedbackLoopRecord {
  return {
    run_id: "run-1",
    loop_id: "loop-1",
    source_stage_id: "review",
    source_attempt: 1,
    policy: {
      target: "implement",
      max_replays: 2,
      on_max_replays: "wait_for_human",
      replay_session: "resume",
    },
    state: "active",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function replayEntry(
  replay: Partial<ReplayEntry["replay"]> = {},
  extra: Partial<Omit<ReplayEntry, "replay">> = {},
): ReplayEntry {
  return {
    replay: {
      run_id: "run-1",
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "implement",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["implement", "review"],
      feedback_envelope: feedbackEnvelope,
      status: "completed",
      created_at: T0,
      updated_at: T0,
      ...replay,
    },
    stage_passes: [],
    fork_generations: [],
    ...extra,
  };
}

function forkGeneration(
  status: ForkGeneration["status"],
  cloneStageIds: string[],
): ForkGeneration {
  return {
    run_id: "run-1",
    generation_id: "gen-1",
    fork_parent_stage_id: "fork",
    generation_number: 1,
    clone_stage_ids: cloneStageIds,
    status,
    created_at: T0,
    updated_at: T0,
  };
}

function historyOf(
  loop: FeedbackLoopRecord,
  replays: ReplayEntry[] = [],
  forkGenerations: ForkGeneration[] = [],
): FeedbackLoopHistory {
  return { loop, replays, fork_generations: forkGenerations };
}

const deferredSendBack = (sourceAttempt: number) => ({
  target: "implement",
  feedback_envelope: feedbackEnvelope,
  source_attempt: sourceAttempt,
});

describe("feedback loop workspace", () => {
  const waitingActive = feedbackLoop({
    state: "waiting_for_human",
    current_replay_number: 2,
    deferred_send_back: deferredSendBack(2),
  });

  it.each([
    { name: "no history", history: [] as FeedbackLoopHistory[] },
    {
      name: "completed replay history",
      history: [historyOf(waitingActive, [replayEntry()])],
    },
  ])("builds only the deferred overlay from the active loop ($name)", ({ history }) => {
    expect(buildFeedbackOverlays(waitingActive, history)).toEqual([
      { from: "review", to: "implement", kind: "deferred" },
    ]);
  });

  const supersededHistory = () => [
    historyOf(feedbackLoop({ current_replay_number: 1 }), [
      replayEntry(
        { status: "active" },
        {
          stage_passes: [
            {
              run_id: "run-1",
              replay_id: "replay-1",
              stage_id: "implement~old",
              stage_attempt: 1,
              session_mode: "resume",
              status: "superseded",
            },
          ],
          fork_generations: [forkGeneration("superseded", ["work~1"])],
        },
      ),
    ]),
  ];

  it("builds a replay overlay from an active replay in history", () => {
    expect(buildFeedbackOverlays(feedbackLoop(), supersededHistory())).toEqual([
      { from: "review", to: "implement", kind: "replay" },
    ]);
  });

  it("collects superseded stage passes and superseded fork clones", () => {
    const history = supersededHistory();
    expect([...collectSupersededStageIds(history)].sort()).toEqual([
      "implement~old",
      "work~1",
    ]);
    expect([...collectSupersededCloneStageIds(history)]).toEqual(["work~1"]);
  });

  it("shows completed replay overlays when no live replays remain", () => {
    const history = [
      historyOf(
        feedbackLoop({
          state: "continued",
          current_replay_number: 1,
          policy: {
            target: "implement",
            max_replays: 2,
            on_max_replays: "require_continue",
            replay_session: "resume",
          },
        }),
        [replayEntry()],
      ),
    ];
    expect(buildFeedbackOverlays(undefined, history)).toEqual([
      { from: "review", to: "implement", kind: "replay" },
    ]);
  });

  it("prefers live replay overlays over completed history", () => {
    const loop = feedbackLoop({ current_replay_number: 2 });
    const history = [
      historyOf(loop, [
        replayEntry({
          target_stage_id: "plan",
          route_stage_ids: ["plan", "implement", "review"],
        }),
        replayEntry({
          replay_id: "replay-2",
          source_attempt: 2,
          replay_number: 2,
          status: "active",
          created_at: "2026-08-18T00:01:00.000Z",
          updated_at: "2026-08-18T00:01:00.000Z",
        }),
      ]),
    ];
    expect(buildFeedbackOverlays(loop, history)).toEqual([
      { from: "review", to: "implement", kind: "replay" },
    ]);
  });

  it("skips superseded and failed replays for overlays", () => {
    const history = [
      historyOf(feedbackLoop(), [
        replayEntry({
          replay_id: "replay-failed",
          target_stage_id: "plan",
          route_stage_ids: ["plan", "implement", "review"],
          status: "failed",
        }),
        replayEntry({ replay_id: "replay-superseded", status: "superseded" }),
      ]),
    ];
    expect(buildFeedbackOverlays(undefined, history)).toEqual([]);
  });

  it("shows feedback decide when waiting_kind is feedback_loop_decision", () => {
    const run = detail(
      [
        stage({ stage_id: "implement", status: "succeeded" }),
        stage({ stage_id: "review", status: "waiting_for_input" }),
      ],
      {
        waiting_stage_id: "review",
        waiting_kind: "feedback_loop_decision",
        waiting_summary: "Feedback loop limit reached",
        active_feedback_loop: waitingActive,
        feedback_loops: [historyOf(waitingActive)],
        pipeline_track: {
          nodes: [
            trackNode({
              stage_id: "implement",
              status: "succeeded",
              readiness: "succeeded",
            }),
            trackNode({
              stage_id: "review",
              status: "waiting_for_input",
              readiness: "waiting",
              layer: 1,
            }),
          ],
          edges: [{ from: "implement", to: "review" }],
        },
      },
    );
    expect(resolveFeedbackDecide(run)).toEqual({
      loopId: "loop-1",
      sourceStageId: "review",
      deferredTarget: "implement",
      replayNumber: 2,
      maxReplays: 2,
      summary: "Feedback loop limit reached",
    });
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.showFeedbackDecide).toBe(true);
    expect(workspace.feedbackOverlays).toEqual([
      { from: "review", to: "implement", kind: "deferred" },
    ]);
    const review = workspace.nodeChrome.find((n) => n.stageId === "review");
    const implement = workspace.nodeChrome.find((n) => n.stageId === "implement");
    expect(review?.isFeedbackSource).toBe(true);
    expect(implement?.isFeedbackTarget).toBe(true);
  });

  it("does not change pipeline_track edge layout when overlays are present", () => {
    const run = detail(
      [
        stage({ stage_id: "implement", status: "succeeded" }),
        stage({ stage_id: "review", status: "succeeded" }),
      ],
      {
        active_feedback_loop: feedbackLoop({
          deferred_send_back: deferredSendBack(1),
        }),
        pipeline_track: {
          nodes: [
            trackNode({
              stage_id: "implement",
              status: "succeeded",
              readiness: "succeeded",
            }),
            trackNode({
              stage_id: "review",
              status: "succeeded",
              readiness: "succeeded",
              layer: 1,
            }),
          ],
          edges: [{ from: "implement", to: "review" }],
        },
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.spatialLayout.edges).toEqual([
      { from: "implement", to: "review" },
    ]);
    expect(workspace.feedbackOverlays).toHaveLength(1);
  });

  it("deferred overlay replaces the policy stub on its route; a replay on another route coexists with the stub", () => {
    const track = {
      nodes: [
        trackNode({
          stage_id: "implement",
          status: "succeeded",
          readiness: "succeeded",
        }),
        trackNode({
          stage_id: "review",
          status: "waiting_for_input",
          readiness: "waiting",
          layer: 1,
          feedback_loop: { target: "implement" },
        }),
        trackNode({
          stage_id: "plan",
          status: "succeeded",
          readiness: "succeeded",
          layer_order: 1,
        }),
      ],
      edges: [],
    };
    expect(buildFeedbackOverlays(waitingActive, [], track)).toEqual([
      { from: "review", to: "implement", kind: "deferred" },
    ]);

    const history = [
      historyOf(feedbackLoop({ current_replay_number: 1 }), [
        replayEntry({
          target_stage_id: "plan",
          route_stage_ids: ["plan", "implement", "review"],
          status: "active",
        }),
      ]),
    ];
    expect(buildFeedbackOverlays(undefined, history, track)).toEqual([
      { from: "review", to: "implement", kind: "policy" },
      { from: "review", to: "plan", kind: "replay" },
    ]);
  });

  it("shows policy overlays on a fresh run via resolveRunWorkspace", () => {
    const run = detail(
      [
        stage({ stage_id: "plan", status: "pending" }),
        stage({ stage_id: "implement", status: "pending" }),
        stage({ stage_id: "review", status: "pending" }),
      ],
      {
        pipeline_track: {
          nodes: [
            trackNode({ stage_id: "plan", readiness: "ready" }),
            trackNode({ stage_id: "implement", layer: 1 }),
            trackNode({
              stage_id: "review",
              layer: 2,
              feedback_loop: { target: "implement" },
            }),
          ],
          edges: [
            { from: "plan", to: "implement" },
            { from: "implement", to: "review" },
          ],
        },
      },
    );
    const workspace = resolveRunWorkspace(stream, run, selection());
    expect(workspace.feedbackOverlays).toEqual([
      { from: "review", to: "implement", kind: "policy" },
    ]);
    expect(
      workspace.nodeChrome.find((n) => n.stageId === "review")?.isFeedbackSource,
    ).toBe(true);
    expect(
      workspace.nodeChrome.find((n) => n.stageId === "implement")?.isFeedbackTarget,
    ).toBe(true);
  });

  const forkJoinTrack = {
    nodes: [
      trackNode({
        stage_id: "fork",
        definition_id: "fork",
        status: "succeeded",
        readiness: "succeeded",
      }),
      ...(["work~1", "work~2", "work~3"] as const).map((id, i) =>
        trackNode({
          stage_id: id,
          definition_id: "work",
          status: i < 2 ? "succeeded" : "running",
          readiness: i < 2 ? "succeeded" : "running",
          layer: 1,
          layer_order: i,
        }),
      ),
      trackNode({ stage_id: "join", definition_id: "join", layer: 2 }),
    ],
    edges: [
      { from: "fork", to: "work~1" },
      { from: "fork", to: "work~2" },
      { from: "fork", to: "work~3" },
      { from: "work~1", to: "join" },
      { from: "work~2", to: "join" },
      { from: "work~3", to: "join" },
    ],
  };

  it.each([
    {
      generation: "superseded",
      visible: ["fork", "work~3", "join"],
      edges: [
        { from: "fork", to: "work~3" },
        { from: "work~3", to: "join" },
      ],
    },
    {
      generation: "active",
      visible: ["fork", "work~1", "work~2", "work~3", "join"],
      edges: forkJoinTrack.edges,
    },
  ] as const)(
    "fork generation $generation: map keeps $visible",
    ({ generation, visible, edges }) => {
      const run = detail(
        [
          stage({ stage_id: "fork", status: "succeeded" }),
          stage({ stage_id: "work~1", status: "succeeded" }),
          stage({ stage_id: "work~2", status: "succeeded" }),
          stage({ stage_id: "work~3", status: "running" }),
          stage({ stage_id: "join", status: "pending" }),
        ],
        {
          pipeline_track: forkJoinTrack,
          feedback_loops: [
            historyOf(feedbackLoop(), [], [
              forkGeneration(generation, ["work~1", "work~2"]),
            ]),
          ],
        },
      );
      const workspace = resolveRunWorkspace(stream, run, selection());
      expect(workspace.spatialLayout.nodes.map((n) => n.stageId)).toEqual(visible);
      expect(workspace.trackStages.map((s) => s.id)).toEqual(visible);
      expect(workspace.nodeChrome.map((c) => c.stageId)).toEqual(visible);
      expect(workspace.spatialLayout.edges).toEqual(edges);
    },
  );
});
