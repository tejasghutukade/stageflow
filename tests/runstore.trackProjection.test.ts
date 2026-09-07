import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import type { RunPipelineDagSnapshot, StageSnapshot } from "../src/runstore/port.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import { overlayPlannedStages } from "../src/runstore/runProjection.js";
import { buildPipelineTrack } from "../src/runstore/trackProjection.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

async function loadDiamondDag(stem: string): Promise<RunPipelineDagSnapshot> {
  const loaded = await loadPipeline(pipelinePath(stem), { cwd: fixtures });
  return buildPipelineDagSnapshotFromLoaded(loaded);
}

function snap(
  stage_id: string,
  status: StageSnapshot["status"],
  extra: Partial<StageSnapshot> = {},
): StageSnapshot {
  return {
    stage_id,
    status,
    events: [],
    envelope: null,
    artifacts: [],
    ...extra,
  };
}

function fanoutDag(): RunPipelineDagSnapshot {
  return {
    stage_ids: [
      "recon",
      "improve-a",
      "improve-b",
      "improve-c",
      "report-a",
      "report-b",
      "report-c",
    ],
    roots: ["recon"],
    childrenOf: {
      recon: ["improve-a", "improve-b", "improve-c"],
      "improve-a": ["report-a"],
      "improve-b": ["report-b"],
      "improve-c": ["report-c"],
    },
    nodes: [
      { id: "recon", needs: null, ancestors: [], stageIndex: 0 },
      { id: "improve-a", needs: "recon", ancestors: ["recon"], stageIndex: 1 },
      { id: "improve-b", needs: "recon", ancestors: ["recon"], stageIndex: 2 },
      { id: "improve-c", needs: "recon", ancestors: ["recon"], stageIndex: 3 },
      {
        id: "report-a",
        needs: "improve-a",
        ancestors: ["recon", "improve-a"],
        stageIndex: 4,
      },
      {
        id: "report-b",
        needs: "improve-b",
        ancestors: ["recon", "improve-b"],
        stageIndex: 5,
      },
      {
        id: "report-c",
        needs: "improve-c",
        ancestors: ["recon", "improve-c"],
        stageIndex: 6,
      },
    ],
  };
}

describe("buildPipelineTrack", () => {
  it("projects fan-out mid-run with parallel siblings on the same layer", () => {
    const dag = fanoutDag();
    const stages = [
      snap("recon", "succeeded", {
        envelope: { status: "success", summary: "recon done", artifacts: [] },
      }),
      snap("improve-a", "running"),
      snap("improve-b", "running"),
      snap("improve-c", "running"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages),
      runStatus: "running",
    });

    const recon = track.nodes.find((n) => n.stage_id === "recon");
    const siblings = track.nodes.filter((n) =>
      ["improve-a", "improve-b", "improve-c"].includes(n.stage_id),
    );
    expect(recon?.status).toBe("succeeded");
    expect(recon?.readiness).toBe("succeeded");
    expect(recon?.layer).toBe(0);
    expect(siblings.every((n) => n.layer === 1)).toBe(true);
    expect(siblings.every((n) => n.status === "running")).toBe(true);
    expect(siblings.every((n) => n.readiness === "running")).toBe(true);
    expect(track.edges).toEqual(
      expect.arrayContaining([
        { from: "recon", to: "improve-a", envelope_summary: "recon done" },
        { from: "recon", to: "improve-b", envelope_summary: "recon done" },
        { from: "recon", to: "improve-c", envelope_summary: "recon done" },
      ]),
    );
  });

  it("marks downstream pending stage blocked while predecessor runs", () => {
    const dag = fanoutDag();
    const stages = [
      snap("recon", "succeeded"),
      snap("improve-b", "running"),
      snap("report-b", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages),
      runStatus: "running",
    });
    const reportB = track.nodes.find((n) => n.stage_id === "report-b");
    expect(reportB?.status).toBe("pending");
    expect(reportB?.readiness).toBe("blocked");
    expect(reportB?.blocked_by).toEqual(["improve-b"]);
    expect(track.nodes.find((n) => n.stage_id === "improve-b")?.readiness).toBe(
      "running",
    );
  });

  it("reflects failure drain with skipped never-started downstream stages", () => {
    const dag = fanoutDag();
    const stages = [
      snap("recon", "succeeded"),
      snap("improve-a", "failed"),
      snap("improve-b", "running"),
      snap("report-a", "pending"),
      snap("report-b", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages),
      runStatus: "failed",
    });
    expect(track.nodes.find((n) => n.stage_id === "improve-a")?.readiness).toBe(
      "failed",
    );
    expect(track.nodes.find((n) => n.stage_id === "improve-b")?.readiness).toBe(
      "running",
    );
    expect(track.nodes.find((n) => n.stage_id === "report-a")?.readiness).toBe(
      "skipped",
    );
    expect(track.nodes.find((n) => n.stage_id === "report-b")?.readiness).toBe(
      "skipped",
    );
  });

  it("projects linear three-node chain with layers 0, 1, 2", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["alpha", "beta", "gamma"],
      roots: ["alpha"],
      childrenOf: { alpha: ["beta"], beta: ["gamma"] },
      nodes: [
        { id: "alpha", needs: null, ancestors: [], stageIndex: 0 },
        { id: "beta", needs: "alpha", ancestors: ["alpha"], stageIndex: 1 },
        {
          id: "gamma",
          needs: "beta",
          ancestors: ["alpha", "beta"],
          stageIndex: 2,
        },
      ],
    };
    const stages = [
      snap("alpha", "succeeded"),
      snap("beta", "running"),
      snap("gamma", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages,
      runStatus: "running",
    });
    expect(track.nodes.map((n) => [n.stage_id, n.layer])).toEqual([
      ["alpha", 0],
      ["beta", 1],
      ["gamma", 2],
    ]);
    expect(track.edges).toEqual([
      { from: "alpha", to: "beta" },
      { from: "beta", to: "gamma" },
    ]);
    expect(track.nodes.find((n) => n.stage_id === "gamma")?.readiness).toBe(
      "blocked",
    );
  });

  it("marks fork-skipped stages with skipped readiness", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["detect", "author"],
      roots: ["detect"],
      childrenOf: { detect: ["author"] },
      nodes: [
        { id: "detect", needs: null, ancestors: [], stageIndex: 0 },
        { id: "author", needs: "detect", ancestors: ["detect"], stageIndex: 1 },
      ],
    };
    const stages = [
      snap("detect", "succeeded"),
      snap("author", "skipped"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages,
      runStatus: "succeeded",
    });
    expect(track.nodes.find((n) => n.stage_id === "author")?.readiness).toBe(
      "skipped",
    );
  });

  it("AE1: freeze-shaped chain track nodes carry definition_id", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["detect", "author-diagrams", "collect"],
      roots: ["detect"],
      childrenOf: { detect: ["author-diagrams"], "author-diagrams": ["collect"] },
      nodes: [
        {
          id: "detect",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          definition_id: "detect",
        },
        {
          id: "author-diagrams",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 1,
          definition_id: "author-diagrams",
        },
        {
          id: "collect",
          needs: "author-diagrams",
          ancestors: ["detect", "author-diagrams"],
          stageIndex: 2,
          definition_id: "collect",
        },
      ],
    };
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    expect(track.nodes.map((n) => [n.stage_id, n.definition_id])).toEqual([
      ["detect", "detect"],
      ["author-diagrams", "author-diagrams"],
      ["collect", "collect"],
    ]);
  });

  it("projects empty gate_kinds instead of dropping them (KTD1)", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["no-hitl"],
      roots: ["no-hitl"],
      childrenOf: {},
      nodes: [
        {
          id: "no-hitl",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          definition_id: "no-hitl",
        },
      ],
      gate_kinds: { "no-hitl": [] },
    };
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    expect(track.nodes.find((n) => n.stage_id === "no-hitl")?.gate_kinds).toEqual(
      [],
    );
  });

  it("resolves gate_kinds for a clone instance via definition_id", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["detect", "author-diagrams~1", "collect"],
      roots: ["detect"],
      childrenOf: {
        detect: ["author-diagrams~1"],
        "author-diagrams": ["collect"],
      },
      nodes: [
        {
          id: "detect",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          definition_id: "detect",
        },
        {
          id: "author-diagrams~1",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 1,
          definition_id: "author-diagrams",
        },
        {
          id: "collect",
          needs: "author-diagrams",
          ancestors: ["detect", "author-diagrams"],
          stageIndex: 2,
          definition_id: "collect",
        },
      ],
      gate_kinds: { "author-diagrams": ["confirm"] },
    };
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    expect(
      track.nodes.find((n) => n.stage_id === "author-diagrams~1")?.gate_kinds,
    ).toEqual(["confirm"]);
    expect(
      track.nodes.find((n) => n.stage_id === "author-diagrams~1")?.definition_id,
    ).toBe("author-diagrams");
  });

  it("AE5: two clone instance ids are distinct track nodes", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["detect", "author-diagrams~1", "author-diagrams~2", "collect"],
      roots: ["detect"],
      childrenOf: {
        detect: ["author-diagrams~1", "author-diagrams~2"],
        "author-diagrams": ["collect"],
      },
      nodes: [
        {
          id: "detect",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          definition_id: "detect",
        },
        {
          id: "author-diagrams~1",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 1,
          definition_id: "author-diagrams",
        },
        {
          id: "author-diagrams~2",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 2,
          definition_id: "author-diagrams",
        },
        {
          id: "collect",
          needs: "author-diagrams",
          ancestors: ["detect", "author-diagrams"],
          stageIndex: 3,
          definition_id: "collect",
        },
      ],
    };
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    const clones = track.nodes.filter(
      (n) => n.definition_id === "author-diagrams",
    );
    expect(clones.map((n) => n.stage_id)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
    ]);
    expect(track.nodes.map((n) => n.stage_id)).not.toContain("author-diagrams");
    expect(clones.every((n) => n.layer === 1)).toBe(true);
    expect(track.nodes.find((n) => n.stage_id === "collect")?.layer).toBe(2);
    expect(track.edges).toEqual(
      expect.arrayContaining([
        { from: "detect", to: "author-diagrams~1" },
        { from: "detect", to: "author-diagrams~2" },
        { from: "author-diagrams~1", to: "collect" },
        { from: "author-diagrams~2", to: "collect" },
      ]),
    );
    expect(track.edges).not.toEqual(
      expect.arrayContaining([{ from: "author-diagrams", to: "collect" }]),
    );
    expect(
      track.nodes.find((n) => n.stage_id === "collect")?.blocked_by,
    ).toEqual(["author-diagrams~1", "author-diagrams~2"]);
  });

  it("AE5: clone join edges carry each instance envelope summary", () => {
    const dag: RunPipelineDagSnapshot = {
      stage_ids: ["detect", "author-diagrams~1", "author-diagrams~2", "collect"],
      roots: ["detect"],
      childrenOf: {
        detect: ["author-diagrams~1", "author-diagrams~2"],
        "author-diagrams": ["collect"],
      },
      nodes: [
        {
          id: "detect",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          definition_id: "detect",
        },
        {
          id: "author-diagrams~1",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 1,
          definition_id: "author-diagrams",
        },
        {
          id: "author-diagrams~2",
          needs: "detect",
          ancestors: ["detect"],
          stageIndex: 2,
          definition_id: "author-diagrams",
        },
        {
          id: "collect",
          needs: "author-diagrams",
          ancestors: ["detect", "author-diagrams"],
          stageIndex: 3,
          definition_id: "collect",
        },
      ],
    };
    const stages = [
      snap("detect", "succeeded", {
        envelope: { status: "success", summary: "detect done", artifacts: [] },
      }),
      snap("author-diagrams~1", "succeeded", {
        envelope: { status: "success", summary: "clone 1 done", artifacts: [] },
      }),
      snap("author-diagrams~2", "succeeded", {
        envelope: { status: "success", summary: "clone 2 done", artifacts: [] },
      }),
      snap("collect", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages, dag),
      runStatus: "running",
    });
    expect(track.nodes.find((n) => n.stage_id === "detect")?.layer).toBe(0);
    expect(
      track.nodes
        .filter((n) => n.definition_id === "author-diagrams")
        .every((n) => n.layer === 1),
    ).toBe(true);
    expect(track.nodes.find((n) => n.stage_id === "collect")?.layer).toBe(2);
    expect(track.nodes.find((n) => n.stage_id === "collect")?.readiness).toBe(
      "ready",
    );
    expect(track.edges).toEqual(
      expect.arrayContaining([
        {
          from: "detect",
          to: "author-diagrams~1",
          envelope_summary: "detect done",
        },
        {
          from: "detect",
          to: "author-diagrams~2",
          envelope_summary: "detect done",
        },
        {
          from: "author-diagrams~1",
          to: "collect",
          envelope_summary: "clone 1 done",
        },
        {
          from: "author-diagrams~2",
          to: "collect",
          envelope_summary: "clone 2 done",
        },
      ]),
    );
    expect(track.edges.some((e) => e.from === "author-diagrams")).toBe(false);
  });

  it("diamond track has both inbound edges and synthesize after both parents", async () => {
    const dag = await loadDiamondDag("diamond-fan-in");
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    const byId = new Map(track.nodes.map((n) => [n.stage_id, n]));
    expect(byId.get("clarify")?.layer).toBe(0);
    expect(byId.get("research")?.layer).toBe(1);
    expect(byId.get("validation")?.layer).toBe(1);
    expect(byId.get("synthesize")?.layer).toBe(2);
    expect(track.edges).toEqual(
      expect.arrayContaining([
        { from: "clarify", to: "research" },
        { from: "clarify", to: "validation" },
        { from: "research", to: "synthesize" },
        { from: "validation", to: "synthesize" },
      ]),
    );
    expect(track.edges.filter((e) => e.to === "synthesize")).toEqual([
      { from: "research", to: "synthesize" },
      { from: "validation", to: "synthesize" },
    ]);
  });

  it("diamond synthesize blocked_by lists both pending parents", async () => {
    const dag = await loadDiamondDag("diamond-fan-in");
    const stages = [
      snap("clarify", "succeeded"),
      snap("research", "pending"),
      snap("validation", "pending"),
      snap("synthesize", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages, dag),
      runStatus: "running",
    });
    const synthesize = track.nodes.find((n) => n.stage_id === "synthesize");
    expect(synthesize?.readiness).toBe("blocked");
    expect(synthesize?.blocked_by).toEqual(["research", "validation"]);
  });

  it("diamond synthesize blocked_by drops the succeeded parent", async () => {
    const dag = await loadDiamondDag("diamond-fan-in");
    const stages = [
      snap("clarify", "succeeded"),
      snap("research", "succeeded"),
      snap("validation", "pending"),
      snap("synthesize", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, stages, dag),
      runStatus: "running",
    });
    const synthesize = track.nodes.find((n) => n.stage_id === "synthesize");
    expect(synthesize?.readiness).toBe("blocked");
    expect(synthesize?.blocked_by).toEqual(["validation"]);
  });

  it("accepted failed parent does not block or overlay-skip the join", async () => {
    const dag = await loadDiamondDag("diamond-fan-in-accepted");
    const blocked = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(
        dag.stage_ids,
        [
          snap("clarify", "succeeded"),
          snap("research", "failed"),
          snap("validation", "pending"),
          snap("synthesize", "pending"),
        ],
        dag,
      ),
      runStatus: "running",
    });
    const blockedJoin = blocked.nodes.find((n) => n.stage_id === "synthesize");
    expect(blockedJoin?.readiness).toBe("blocked");
    expect(blockedJoin?.blocked_by).toEqual(["validation"]);

    const ready = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(
        dag.stage_ids,
        [
          snap("clarify", "succeeded"),
          snap("research", "failed"),
          snap("validation", "succeeded"),
          snap("synthesize", "pending"),
        ],
        dag,
      ),
      runStatus: "running",
    });
    const readyJoin = ready.nodes.find((n) => n.stage_id === "synthesize");
    expect(readyJoin?.readiness).toBe("ready");
    expect(readyJoin?.blocked_by).toBeUndefined();
    expect(ready.nodes.find((n) => n.stage_id === "research")?.readiness).toBe(
      "failed",
    );
  });

  it("clone-parent diamond join edges come from clone instances", async () => {
    const catalog = await loadDiamondDag("diamond-fan-in-clone");
    const { snapshot: dag } = appendCloneInstances(catalog, {
      catalogId: "research",
      predecessorId: "clarify",
      count: 2,
    });
    const track = buildPipelineTrack({
      dagSnapshot: dag,
      stages: overlayPlannedStages(dag.stage_ids, [], dag),
      runStatus: "created",
    });
    expect(track.nodes.map((n) => n.stage_id)).toEqual([
      "clarify",
      "research~1",
      "research~2",
      "validation",
      "synthesize",
    ]);
    expect(track.nodes.find((n) => n.stage_id === "synthesize")?.layer).toBe(2);
    expect(track.edges).toEqual(
      expect.arrayContaining([
        { from: "research~1", to: "synthesize" },
        { from: "research~2", to: "synthesize" },
        { from: "validation", to: "synthesize" },
      ]),
    );
    expect(track.edges.some((e) => e.from === "research")).toBe(false);
    expect(
      track.nodes.find((n) => n.stage_id === "synthesize")?.blocked_by,
    ).toEqual(["research~1", "research~2", "validation"]);
  });

  it("falls back to linear compat when dag snapshot is missing", () => {
    const stages = [
      snap("alpha", "succeeded"),
      snap("beta", "running"),
      snap("gamma", "pending"),
    ];
    const track = buildPipelineTrack({
      dagSnapshot: null,
      stages,
      runStatus: "running",
    });
    expect(track.nodes).toHaveLength(3);
    expect(track.edges).toEqual([
      { from: "alpha", to: "beta" },
      { from: "beta", to: "gamma" },
    ]);
  });
});
