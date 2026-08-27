import { describe, expect, it } from "vitest";
import type { RunPipelineDagSnapshot, StageSnapshot } from "../src/runstore/port.js";
import { overlayPlannedStages } from "../src/runstore/runProjection.js";
import { buildPipelineTrack } from "../src/runstore/trackProjection.js";

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
