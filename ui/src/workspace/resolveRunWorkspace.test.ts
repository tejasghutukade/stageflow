import { describe, expect, it } from "vitest";
import type { PendingPrompt, PipelineTrackNode, RunDetail, StageSnapshot } from "../api";
import type { DetailView } from "../routes";
import { statusCopy } from "../status/runStatus";
import {
  envelopeAsidePath,
  formatCloneLabel,
  parseEnvelopeAsidePath,
  resolveRunWorkspace,
  runDetailShouldPoll,
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
  it("with no operator pick selects the first waiting_for_input stage", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "clarify", status: "waiting_for_input" }),
      stage({ stage_id: "review", status: "waiting_for_input" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("clarify");
  });

  it("prefers waiting_stage_id when it is set", () => {
    const run = detail(
      [
        stage({ stage_id: "clarify", status: "waiting_for_input" }),
        stage({ stage_id: "review", status: "waiting_for_input" }),
      ],
      { waiting_stage_id: "review" },
    );
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("review");
  });

  it("with no waiting stage selects the first running stage", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "build", status: "running" }),
      stage({ stage_id: "review", status: "pending" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("build");
  });

  it("with neither waiting nor running selects the first failed stage", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "build", status: "failed" }),
      stage({ stage_id: "review", status: "pending" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("build");
  });

  it("with no waiting, running, or failed keeps the previous selection", () => {
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
    ).toBe("review");
  });

  it("with no previous selection falls back to the first stage", () => {
    const run = detail([
      stage({ stage_id: "intake", status: "succeeded" }),
      stage({ stage_id: "review", status: "succeeded" }),
    ]);
    expect(
      resolveRunWorkspace(stream, run, selection()).selectedStageId,
    ).toBe("intake");
  });

  it("preserves an operator pick when the stage still exists", () => {
    const run = detail(
      [
        stage({ stage_id: "clarify", status: "waiting_for_input" }),
        stage({ stage_id: "review", status: "pending" }),
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

  it("drops an operator pick when the stage no longer exists", () => {
    const run = detail(
      [
        stage({ stage_id: "clarify", status: "waiting_for_input" }),
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
});

describe("composer and session chip", () => {
  it("stream + waiting + pending_prompt returns a composer that accepts a reply", () => {
    const run = detail([
      stage({
        stage_id: "clarify",
        status: "waiting_for_input",
        pending_prompt: freeText,
      }),
    ]);
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
    expect(workspace.selectedStageId).toBe("a");
    expect(workspace.trackStages).toEqual([
      {
        id: "a",
        label: "a",
        status: "running",
        selected: true,
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

describe("DAG track layout", () => {
  it("uses dag mode for fan-out projection", () => {
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
    expect(workspace.trackLayout.mode).toBe("dag");
    expect(workspace.detailListRows.filter((r) => r.isWaitingAttention)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stageId: "improve-a" }),
        expect.objectContaining({ stageId: "improve-c" }),
      ]),
    );
    expect(workspace.selectedStageId).toBe("improve-a");
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

  it("shows blocked readiness on detail rows", () => {
    const run = detail(
      [
        stage({ stage_id: "improve-b", status: "running" }),
        stage({ stage_id: "report-b", status: "pending" }),
      ],
      { pipeline_track: fanOutTrack },
    );
    const row = resolveRunWorkspace(stream, run, selection()).detailListRows.find(
      (r) => r.stageId === "report-b",
    );
    expect(row?.readinessLine).toBe("Blocked on improve-b");
  });

  it("passes attempt_count into detail list rows", () => {
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
    const row = resolveRunWorkspace(stream, run, selection()).detailListRows.find(
      (r) => r.stageId === "improve-b",
    );
    expect(row?.attemptCount).toBe(2);
  });

  it("keeps linear mode for single-chain projection", () => {
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
    expect(workspace.trackLayout.mode).toBe("linear");
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
    expect(workspace.trackLayout.mode).toBe("dag");
    if (workspace.trackLayout.mode !== "dag") return;
    expect(workspace.trackLayout.dagLayers[1]?.map((n) => n.id)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(workspace.trackLayout.dagLayers[1]?.map((n) => n.label)).toEqual([
      "author-diagrams · 1",
      "author-diagrams · 2",
      "author-diagrams · 3",
    ]);
    expect(workspace.trackStages.find((s) => s.id === "detect-changes")?.label).toBe(
      "detect-changes",
    );
    expect(workspace.trackStages.find((s) => s.id === "collect")?.label).toBe(
      "collect",
    );
    expect(
      workspace.detailListRows.find((r) => r.stageId === "author-diagrams~2")?.label,
    ).toBe("author-diagrams · 2");

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
    expect(workspace.trackLayout.mode).toBe("linear");
    expect(workspace.trackStages.find((s) => s.id === "author-diagrams")?.label).toBe(
      "author-diagrams",
    );
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
    expect(workspace.detailListRows.filter((r) => r.isWaitingAttention).map((r) => r.stageId)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
    ]);

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
