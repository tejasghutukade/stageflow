import { describe, expect, it } from "vitest";
import type { PipelineTrackNode, PipelineTrackProjection } from "../api";
import {
  SPATIAL_COL_W,
  SPATIAL_NODE_H,
  SPATIAL_NODE_W,
  SPATIAL_ROW_H,
  detailListOrder,
  edgesBetweenLayers,
  groupNodesByLayer,
  isLinearPipelineTrack,
  layoutSpatialTrack,
  spatialLayerYOffset,
} from "./layoutPipelineTrack";

function node(
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

describe("groupNodesByLayer", () => {
  it("groups fan-out siblings in layer 1 after root", () => {
    const nodes: PipelineTrackNode[] = [
      node({ stage_id: "recon", layer: 0, layer_order: 0, status: "succeeded", readiness: "succeeded" }),
      node({ stage_id: "improve-a", layer: 1, layer_order: 0, status: "running", readiness: "running" }),
      node({ stage_id: "improve-b", layer: 1, layer_order: 1, status: "running", readiness: "running" }),
      node({ stage_id: "improve-c", layer: 1, layer_order: 2, status: "running", readiness: "running" }),
      node({ stage_id: "report-a", layer: 2, layer_order: 0, status: "pending", readiness: "blocked" }),
    ];
    const layers = groupNodesByLayer(nodes);
    expect(layers).toHaveLength(3);
    expect(layers[0]!.map((n) => n.stage_id)).toEqual(["recon"]);
    expect(layers[1]!.map((n) => n.stage_id)).toEqual([
      "improve-a",
      "improve-b",
      "improve-c",
    ]);
    expect(layers[2]!.map((n) => n.stage_id)).toEqual(["report-a"]);
  });

  it("groups three clone instance ids in one layer like named siblings", () => {
    const nodes: PipelineTrackNode[] = [
      node({
        stage_id: "detect-changes",
        layer: 0,
        layer_order: 0,
        status: "succeeded",
        readiness: "succeeded",
      }),
      node({
        stage_id: "author-diagrams~1",
        layer: 1,
        layer_order: 0,
        status: "running",
        readiness: "running",
      }),
      node({
        stage_id: "author-diagrams~2",
        layer: 1,
        layer_order: 1,
        status: "running",
        readiness: "running",
      }),
      node({
        stage_id: "author-diagrams~3",
        layer: 1,
        layer_order: 2,
        status: "running",
        readiness: "running",
      }),
      node({
        stage_id: "collect",
        layer: 2,
        layer_order: 0,
        status: "pending",
        readiness: "blocked",
      }),
    ];
    const layers = groupNodesByLayer(nodes);
    expect(layers).toHaveLength(3);
    expect(layers[1]!.map((n) => n.stage_id)).toEqual([
      "author-diagrams~1",
      "author-diagrams~2",
      "author-diagrams~3",
    ]);
    expect(
      isLinearPipelineTrack({
        nodes,
        edges: [
          { from: "detect-changes", to: "author-diagrams~1" },
          { from: "detect-changes", to: "author-diagrams~2" },
          { from: "detect-changes", to: "author-diagrams~3" },
        ],
      }),
    ).toBe(false);
  });
});

describe("detailListOrder", () => {
  it("sorts by layer asc then layer_order asc", () => {
    const nodes: PipelineTrackNode[] = [
      node({ stage_id: "c", layer: 2, layer_order: 0 }),
      node({ stage_id: "b2", layer: 1, layer_order: 1 }),
      node({ stage_id: "a", layer: 0, layer_order: 0 }),
      node({ stage_id: "b1", layer: 1, layer_order: 0 }),
    ];
    expect(detailListOrder(nodes).map((n) => n.stage_id)).toEqual([
      "a",
      "b1",
      "b2",
      "c",
    ]);
  });
});

describe("isLinearPipelineTrack", () => {
  it("returns true for a three-node chain", () => {
    const projection: PipelineTrackProjection = {
      nodes: [
        node({ stage_id: "a", layer: 0, layer_order: 0 }),
        node({ stage_id: "b", layer: 1, layer_order: 0 }),
        node({ stage_id: "c", layer: 2, layer_order: 0 }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(isLinearPipelineTrack(projection)).toBe(true);
  });

  it("returns true for a single node", () => {
    expect(
      isLinearPipelineTrack({
        nodes: [node({ stage_id: "only" })],
        edges: [],
      }),
    ).toBe(true);
  });

  it("returns false for a branch tree with fan-out", () => {
    const projection: PipelineTrackProjection = {
      nodes: [
        node({ stage_id: "recon", layer: 0, layer_order: 0 }),
        node({ stage_id: "improve-a", layer: 1, layer_order: 0 }),
        node({ stage_id: "improve-b", layer: 1, layer_order: 1 }),
        node({ stage_id: "report-a", layer: 2, layer_order: 0 }),
      ],
      edges: [
        { from: "recon", to: "improve-a" },
        { from: "recon", to: "improve-b" },
        { from: "improve-a", to: "report-a" },
      ],
    };
    expect(isLinearPipelineTrack(projection)).toBe(false);
  });
});

describe("edgesBetweenLayers", () => {
  it("returns edges crossing adjacent layers only", () => {
    const nodes: PipelineTrackNode[] = [
      node({ stage_id: "recon", layer: 0, layer_order: 0 }),
      node({ stage_id: "improve-a", layer: 1, layer_order: 0 }),
      node({ stage_id: "improve-b", layer: 1, layer_order: 1 }),
      node({ stage_id: "report-a", layer: 2, layer_order: 0 }),
    ];
    const edges = [
      { from: "recon", to: "improve-a" },
      { from: "recon", to: "improve-b" },
      { from: "improve-a", to: "report-a" },
    ];
    expect(edgesBetweenLayers(edges, nodes, 0, 1)).toEqual([
      { from: "recon", to: "improve-a" },
      { from: "recon", to: "improve-b" },
    ]);
    expect(edgesBetweenLayers(edges, nodes, 1, 2)).toEqual([
      { from: "improve-a", to: "report-a" },
    ]);
  });
});

describe("layoutSpatialTrack", () => {
  it("lays out a linear three-stage chain as three columns and one row", () => {
    const projection: PipelineTrackProjection = {
      nodes: [
        node({ stage_id: "a", layer: 0, layer_order: 0 }),
        node({ stage_id: "b", layer: 1, layer_order: 0 }),
        node({ stage_id: "c", layer: 2, layer_order: 0 }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    expect(isLinearPipelineTrack(projection)).toBe(true);
    const layout = layoutSpatialTrack(projection);
    expect(layout.nodes.map((n) => ({ id: n.stageId, x: n.x, y: n.y }))).toEqual([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: SPATIAL_COL_W, y: 0 },
      { id: "c", x: SPATIAL_COL_W * 2, y: 0 },
    ]);
    expect(layout.nodes.every((n) => n.width === SPATIAL_NODE_W && n.height === SPATIAL_NODE_H)).toBe(
      true,
    );
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("places clone siblings on one x and centers single-node columns on the fan-out", () => {
    const projection: PipelineTrackProjection = {
      nodes: [
        node({ stage_id: "root", layer: 0, layer_order: 0 }),
        node({ stage_id: "a", layer: 1, layer_order: 0 }),
        node({ stage_id: "b", layer: 1, layer_order: 1 }),
        node({ stage_id: "c", layer: 1, layer_order: 2 }),
        node({ stage_id: "join", layer: 2, layer_order: 0 }),
      ],
      edges: [
        { from: "root", to: "a" },
        { from: "root", to: "b" },
        { from: "root", to: "c" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "c", to: "join" },
      ],
    };
    const layout = layoutSpatialTrack(projection);
    const midY = SPATIAL_ROW_H;
    expect(layout.nodes.map((n) => ({ id: n.stageId, x: n.x, y: n.y }))).toEqual([
      { id: "root", x: 0, y: midY },
      { id: "a", x: SPATIAL_COL_W, y: 0 },
      { id: "b", x: SPATIAL_COL_W, y: SPATIAL_ROW_H },
      { id: "c", x: SPATIAL_COL_W, y: SPATIAL_ROW_H * 2 },
      { id: "join", x: SPATIAL_COL_W * 2, y: midY },
    ]);
  });

  it("computes a vertical offset that centers a shorter layer in the tallest stack", () => {
    expect(spatialLayerYOffset(1, 3)).toBe(SPATIAL_ROW_H);
    expect(spatialLayerYOffset(3, 3)).toBe(0);
    expect(spatialLayerYOffset(1, 1)).toBe(0);
  });

  it("keeps skip-layer and extra edges in the edge list", () => {
    const projection: PipelineTrackProjection = {
      nodes: [
        node({ stage_id: "a", layer: 0, layer_order: 0 }),
        node({ stage_id: "b", layer: 1, layer_order: 0 }),
        node({ stage_id: "c", layer: 2, layer_order: 0 }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
      ],
    };
    expect(layoutSpatialTrack(projection).edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ]);
  });

  it("falls back to a single row of planned ids when nodes are empty", () => {
    const layout = layoutSpatialTrack(
      { nodes: [], edges: [] },
      { liveStageIds: ["a"], plannedStageIds: ["a", "b", "c"] },
    );
    expect(layout.nodes.map((n) => ({ id: n.stageId, x: n.x, y: n.y }))).toEqual([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: SPATIAL_COL_W, y: 0 },
      { id: "c", x: SPATIAL_COL_W * 2, y: 0 },
    ]);
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("appends live stages missing from planned ids in the empty-node fallback", () => {
    const layout = layoutSpatialTrack(
      { nodes: [], edges: [] },
      { liveStageIds: ["a", "orphan"], plannedStageIds: ["a", "b"] },
    );
    expect(layout.nodes.map((n) => n.stageId)).toEqual(["a", "b", "orphan"]);
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "orphan" },
    ]);
  });
});
