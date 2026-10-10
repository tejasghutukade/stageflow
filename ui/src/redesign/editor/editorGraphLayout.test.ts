import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import {
  buildEditorGraphLayout,
  connectorGeometry,
  editorGraphToolbarSummary,
  editorStageCardModel,
  formatDurationShort,
  formatStageStats,
  stageRowCenters,
  stageRowWidth,
} from "./editorGraphLayout";
import type { ConnectorSegment } from "./editorGraphLayout";
import { buildEditorLiveGraph } from "./editorLiveGraph";

function sorted(segments: ConnectorSegment[]): ConnectorSegment[] {
  return [...segments].sort(
    (a, b) => a.axis.localeCompare(b.axis) || a.left - b.left || a.top - b.top,
  );
}

const forkMergeDraft: DraftPackagePayload = {
  pipeline: {
    id: "feature-ship",
    stages: [
      { id: "plan" },
      { id: "implement" },
      { id: "review", needs: ["implement"] },
      { id: "test", needs: ["implement"] },
      { id: "ship", needs: ["review", "test"] },
    ],
  },
};

describe("formatDurationShort", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDurationShort(45_000)).toBe("45s");
    expect(formatDurationShort(125_000)).toBe("2m 05s");
    expect(formatDurationShort(1_058_000)).toBe("17m 38s");
    expect(formatDurationShort(3_720_000)).toBe("1h 02m");
    expect(formatDurationShort(0)).toBe("0s");
  });
});

describe("formatStageStats", () => {
  it("joins the available parts", () => {
    expect(formatStageStats({ runs: 12, avgMs: 125_000, avgCostUsd: 0.08, passRate: 0.99 })).toBe(
      "avg 2m 05s · $0.08 · 99% pass",
    );
    expect(formatStageStats({ runs: 3, avgCostUsd: 0.614 })).toBe("$0.61");
    expect(formatStageStats({ runs: 3, passRate: 0.875 })).toBe("88% pass");
  });

  it("falls back when there are no runs or no parts", () => {
    expect(formatStageStats(undefined)).toBe("no runs yet");
    expect(formatStageStats({ runs: 0, avgMs: 1000 })).toBe("no runs yet");
    expect(formatStageStats({ runs: 1 })).toBe("1 run");
    expect(formatStageStats({ runs: 4 })).toBe("4 runs");
  });
});

describe("editorGraphToolbarSummary", () => {
  it("appends p50 when known", () => {
    expect(editorGraphToolbarSummary(5, 2, 1_058_000)).toBe("5 stages · 2 parallel · p50 17m 38s");
    expect(editorGraphToolbarSummary(5, 2, null)).toBe("5 stages · 2 parallel");
  });
});

describe("stage row geometry", () => {
  it("centers narrower rows inside the widest row", () => {
    expect(stageRowWidth(0)).toBe(0);
    expect(stageRowWidth(2)).toBe(452);
    expect(stageRowCenters(2, 452)).toEqual([109, 343]);
    expect(stageRowCenters(1, 452)).toEqual([226]);
  });
});

describe("connectorGeometry", () => {
  it("draws a single straight edge", () => {
    expect(connectorGeometry(1, 1, [{ from: 0, to: 0 }])).toEqual({
      width: 218,
      height: 22,
      segments: [{ axis: "y", left: 109, top: 0, length: 22, highlighted: false }],
    });
  });

  it("draws a fork with a trunk, crossbar, and two stubs", () => {
    const geometry = connectorGeometry(1, 2, [
      { from: 0, to: 0 },
      { from: 0, to: 1 },
    ]);
    expect(geometry.width).toBe(452);
    expect(geometry.height).toBe(28);
    expect(sorted(geometry.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 235, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 226, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 14, length: 14, highlighted: false },
    ]);
  });

  it("draws a merge with two stubs, crossbar, and a trunk", () => {
    const geometry = connectorGeometry(2, 1, [
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
    expect(sorted(geometry.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 235, highlighted: false },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 226, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 0, length: 14, highlighted: false },
    ]);
  });

  it("joins crossing 2→2 edges on one crossbar", () => {
    const geometry = connectorGeometry(2, 2, [
      { from: 0, to: 1 },
      { from: 1, to: 0 },
    ]);
    expect(geometry.height).toBe(28);
    expect(sorted(geometry.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 235, highlighted: false },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 14, length: 14, highlighted: false },
    ]);
  });

  it("keeps parallel 2→2 lanes straight and separate", () => {
    const geometry = connectorGeometry(2, 2, [
      { from: 0, to: 0 },
      { from: 1, to: 1 },
    ]);
    expect(geometry.height).toBe(22);
    expect(sorted(geometry.segments)).toEqual([
      { axis: "y", left: 109, top: 0, length: 22, highlighted: false },
      { axis: "y", left: 343, top: 0, length: 22, highlighted: false },
    ]);
  });

  it("highlights only the path of highlighted edges and draws it last", () => {
    const geometry = connectorGeometry(1, 2, [
      { from: 0, to: 0, highlighted: true },
      { from: 0, to: 1 },
    ]);
    expect(sorted(geometry.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 117, highlighted: true },
      { axis: "x", left: 226, top: 14, length: 118, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: true },
      { axis: "y", left: 226, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 14, length: 14, highlighted: false },
    ]);
    const firstHighlighted = geometry.segments.findIndex((segment) => segment.highlighted);
    expect(geometry.segments.slice(firstHighlighted).every((segment) => segment.highlighted)).toBe(true);
  });

  it("routes skip-layer rails beside the rows", () => {
    const start = connectorGeometry(1, 1, [{ from: 0, to: 0 }], {
      width: 235,
      rails: [{ x: 234, kind: "start", node: 0 }],
    });
    expect(start.width).toBe(235);
    expect(start.height).toBe(28);
    expect(sorted(start.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 126, highlighted: false },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 234, top: 14, length: 14, highlighted: false },
    ]);
    const pass = connectorGeometry(1, 1, [{ from: 0, to: 0 }], {
      width: 235,
      rails: [{ x: 234, kind: "pass", highlighted: true }],
    });
    expect(pass.height).toBe(22);
    expect(sorted(pass.segments)).toEqual([
      { axis: "y", left: 109, top: 0, length: 22, highlighted: false },
      { axis: "y", left: 234, top: 0, length: 22, highlighted: true },
    ]);
    const end = connectorGeometry(1, 1, [], { width: 235, rails: [{ x: 234, kind: "end", node: 0 }] });
    expect(sorted(end.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 126, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 234, top: 0, length: 14, highlighted: false },
    ]);
  });
});

describe("buildEditorGraphLayout", () => {
  it("lays out the Wonder fork/merge pipeline and highlights the selected stage edges", () => {
    const layout = buildEditorGraphLayout(buildEditorLiveGraph(forkMergeDraft), "review");
    expect(layout.rows.map((row) => row.nodes.map((node) => node.stageId))).toEqual([
      ["plan"],
      ["implement"],
      ["review", "test"],
      ["ship"],
    ]);
    expect(layout.lanes).toBe(2);
    expect(layout.rowsWidth).toBe(452);
    expect(layout.width).toBe(452);
    expect(layout.railCount).toBe(0);
    expect(layout.connectors[0]!.segments).toEqual([
      { axis: "y", left: 226, top: 0, length: 22, highlighted: false },
    ]);
    expect(sorted(layout.connectors[1]!.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 117, highlighted: true },
      { axis: "x", left: 226, top: 14, length: 118, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: true },
      { axis: "y", left: 226, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 14, length: 14, highlighted: false },
    ]);
    expect(sorted(layout.connectors[2]!.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 117, highlighted: true },
      { axis: "x", left: 226, top: 14, length: 118, highlighted: false },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: true },
      { axis: "y", left: 226, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 343, top: 0, length: 14, highlighted: false },
    ]);
  });

  it("highlights nothing without a selection", () => {
    const layout = buildEditorGraphLayout(buildEditorLiveGraph(forkMergeDraft), null);
    expect(layout.connectors.flatMap((c) => c.segments).some((s) => s.highlighted)).toBe(false);
  });

  it("routes an edge that skips a layer on a rail", () => {
    const layout = buildEditorGraphLayout(
      {
        stageCount: 3,
        layers: [
          [{ key: "a", stageId: "a", loop: false, chips: [] }],
          [{ key: "b", stageId: "b", loop: false, chips: [] }],
          [{ key: "c", stageId: "c", loop: false, chips: [] }],
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "a", to: "c" },
        ],
      },
      "c",
    );
    expect(layout.railCount).toBe(1);
    expect(layout.rowsWidth).toBe(218);
    expect(layout.width).toBe(235);
    expect(layout.rows.map((row) => row.rails)).toEqual([[], [{ x: 234, highlighted: true }], []]);
    expect(sorted(layout.connectors[0]!.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 126, highlighted: true },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: false },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: false },
      { axis: "y", left: 234, top: 14, length: 14, highlighted: true },
    ]);
    expect(sorted(layout.connectors[1]!.segments)).toEqual([
      { axis: "x", left: 109, top: 14, length: 126, highlighted: true },
      { axis: "y", left: 109, top: 0, length: 14, highlighted: true },
      { axis: "y", left: 109, top: 14, length: 14, highlighted: true },
      { axis: "y", left: 234, top: 0, length: 14, highlighted: true },
    ]);
  });

  it("reuses a rail lane for non-overlapping skips", () => {
    const node = (id: string) => ({ key: id, stageId: id, loop: false, chips: [] });
    const layout = buildEditorGraphLayout(
      {
        stageCount: 5,
        layers: [[node("a")], [node("b")], [node("c")], [node("d")], [node("e")]],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "d" },
          { from: "d", to: "e" },
          { from: "a", to: "c" },
          { from: "c", to: "e" },
          { from: "b", to: "d" },
        ],
      },
      null,
    );
    expect(layout.railCount).toBe(2);
    expect(layout.width).toBe(218 + 16 + 10 + 1);
  });

  it("turns loop nodes into chips on the source card", () => {
    const layout = buildEditorGraphLayout(
      buildEditorLiveGraph({
        pipeline: {
          id: "loop",
          stages: [
            { id: "review", entry: true, route: [{ to: "address" }] },
            {
              id: "address",
              route: [{ to: "publish" }, { type: "loop", to: "review", max_replays: 2 }],
            },
            { id: "publish" },
          ],
        },
      }),
      null,
    );
    expect(layout.rows.map((row) => row.nodes.map((node) => node.stageId))).toEqual([
      ["review"],
      ["address"],
      ["publish"],
    ]);
    expect(layout.rows[1]!.nodes[0]!.loops).toEqual(["review"]);
    expect(layout.lanes).toBe(1);
    expect(layout.connectors).toHaveLength(2);
    expect(layout.connectors[1]!.height).toBe(22);
  });

  it("handles an empty graph", () => {
    const layout = buildEditorGraphLayout({ stageCount: 0, layers: [], edges: [] }, null);
    expect(layout.rows).toEqual([]);
    expect(layout.connectors).toEqual([]);
    expect(layout.width).toBe(0);
  });
});

describe("editorStageCardModel", () => {
  it("resolves the model, gate kinds, and needs", () => {
    const draft: DraftPackagePayload = {
      pipeline: {
        id: "p",
        model: "anthropic/claude-sonnet-4-5",
        stages: [
          { id: "review", uses: "./stages/review.yaml" },
          { id: "test", model: "openai/gpt-5.2" },
          { id: "ship", needs: ["review", "test"] },
        ],
      },
      stages: [
        { path: "stages/review.yaml", body: { id: "review", gate_kinds: ["confirm", "artifact_backed"] } },
      ],
    };
    expect(editorStageCardModel(draft, "review", null)).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      gateKinds: ["confirm", "artifact_backed"],
      needs: [],
    });
    expect(editorStageCardModel(draft, "test", null).model).toBe("openai/gpt-5.2");
    expect(editorStageCardModel(draft, "ship", "fallback").needs).toEqual(["review", "test"]);
    expect(editorStageCardModel(draft, "missing", "fallback")).toEqual({
      model: null,
      gateKinds: [],
      needs: [],
    });
  });

  it("falls back to the default model", () => {
    const draft: DraftPackagePayload = { pipeline: { id: "p", stages: [{ id: "a" }] } };
    expect(editorStageCardModel(draft, "a", "claude-sonnet-4-5").model).toBe("claude-sonnet-4-5");
  });
});
