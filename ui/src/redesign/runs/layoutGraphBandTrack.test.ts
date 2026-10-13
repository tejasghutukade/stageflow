import { describe, expect, it } from "vitest";
import {
  GRAPH_BAND_NODE_ANCHOR_Y,
  graphBandEdgePath,
  layoutGraphBandTrack,
} from "./layoutGraphBandTrack";

describe("layoutGraphBandTrack", () => {
  it("scales spatial columns into compact band coordinates", () => {
    const layout = layoutGraphBandTrack({
      nodes: [
        { stageId: "a", x: 0, y: 0, width: 400, height: 128, layerIndex: 0, indexInLayer: 0 },
        { stageId: "b", x: 520, y: 0, width: 400, height: 128, layerIndex: 1, indexInLayer: 0 },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(layout.nodes.map((n) => n.stageId)).toEqual(["a", "b"]);
    expect(layout.nodes[0]?.x).toBe(40);
    expect(layout.nodes[1]?.x).toBe(200);
    const path = graphBandEdgePath(layout.nodes[0]!, layout.nodes[1]!);
    expect(path).toContain("M160 ");
    expect(path).toContain(" 200 ");
  });

  it("draws separate fork curves to each branch anchor", () => {
    const layout = layoutGraphBandTrack({
      nodes: [
        {
          stageId: "decide",
          x: 0,
          y: 170,
          width: 400,
          height: 128,
          layerIndex: 0,
          indexInLayer: 0,
        },
        {
          stageId: "branch-a",
          x: 520,
          y: 0,
          width: 400,
          height: 128,
          layerIndex: 1,
          indexInLayer: 0,
        },
        {
          stageId: "branch-b",
          x: 520,
          y: 340,
          width: 400,
          height: 128,
          layerIndex: 1,
          indexInLayer: 1,
        },
      ],
      edges: [
        { from: "decide", to: "branch-a" },
        { from: "decide", to: "branch-b" },
      ],
    });
    const decide = layout.nodes.find((n) => n.stageId === "decide")!;
    const branchA = layout.nodes.find((n) => n.stageId === "branch-a")!;
    const branchB = layout.nodes.find((n) => n.stageId === "branch-b")!;
    const pathA = graphBandEdgePath(decide, branchA)!;
    const pathB = graphBandEdgePath(decide, branchB)!;
    expect(pathA).not.toEqual(pathB);
    const endA = branchA.x;
    const endAy = branchA.y + GRAPH_BAND_NODE_ANCHOR_Y;
    const endBy = branchB.y + GRAPH_BAND_NODE_ANCHOR_Y;
    expect(pathA.endsWith(`${endA} ${endAy}`)).toBe(true);
    expect(pathB.endsWith(`${endA} ${endBy}`)).toBe(true);
    expect(endAy).not.toBe(endBy);
  });
});
