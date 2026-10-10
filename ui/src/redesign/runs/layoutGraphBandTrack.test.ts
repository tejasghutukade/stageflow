import { describe, expect, it } from "vitest";
import {
  graphBandEdgeSegment,
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
    const segment = graphBandEdgeSegment(layout.nodes[0]!, layout.nodes[1]!);
    expect(segment?.width).toBe(40);
  });
});
