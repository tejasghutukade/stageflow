import { describe, expect, it } from "vitest";
import { projectionFromDraft } from "./buildEditorDag";
import { groupNodesByLayer } from "../../track/layoutPipelineTrack";

describe("projectionFromDraft", () => {
  it("builds linear edges when needs are absent", () => {
    const projection = projectionFromDraft({
      pipeline: {
        id: "p",
        stages: [{ id: "a" }, { id: "b" }, { id: "c" }],
      },
    });
    expect(projection.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    const layers = groupNodesByLayer(projection.nodes);
    expect(layers.map((layer) => layer.map((n) => n.stage_id))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("respects needs for dag layers", () => {
    const projection = projectionFromDraft({
      pipeline: {
        id: "p",
        stages: [
          { id: "recon" },
          { id: "ship-a", needs: "recon" },
          { id: "ship-b", needs: "recon" },
          { id: "report", needs: ["ship-a", "ship-b"] },
        ],
      },
    });
    const layers = groupNodesByLayer(projection.nodes);
    expect(layers[0]!.map((n) => n.stage_id)).toEqual(["recon"]);
    expect(layers[1]!.map((n) => n.stage_id).sort()).toEqual([
      "ship-a",
      "ship-b",
    ]);
    expect(layers[2]!.map((n) => n.stage_id)).toEqual(["report"]);
  });
});
