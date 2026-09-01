import { describe, expect, it } from "vitest";
import type { StageSnapshot } from "../api";
import {
  SPATIAL_NODE_H,
  SPATIAL_NODE_W,
  type SpatialNodeBox,
} from "../track/layoutPipelineTrack";
import {
  PAN_CLICK_THRESHOLD_PX,
  SPATIAL_FIT_TOOL_INSET,
  envelopeEdgeEnabled,
  fitTransform,
  isPanGesture,
  selectableSpatialStageIds,
  shouldRefitOnViewportChange,
  spatialFitBounds,
  spatialNodeAction,
  spatialNodeKicker,
} from "./SpatialRunMap";

function box(
  stageId: string,
  x: number,
  y: number,
): SpatialNodeBox {
  return {
    stageId,
    x,
    y,
    width: SPATIAL_NODE_W,
    height: SPATIAL_NODE_H,
    layerIndex: 0,
    indexInLayer: 0,
  };
}

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

describe("isPanGesture", () => {
  it("treats a zero delta as a click", () => {
    expect(isPanGesture(0, 0)).toBe(false);
  });

  it("treats a delta greater than 4px as a pan", () => {
    expect(isPanGesture(PAN_CLICK_THRESHOLD_PX + 0.1, 0)).toBe(true);
    expect(isPanGesture(0, 5)).toBe(true);
  });

  it("treats a 4px delta as a click", () => {
    expect(isPanGesture(PAN_CLICK_THRESHOLD_PX, 0)).toBe(false);
  });
});

describe("spatialFitBounds", () => {
  it("contains every node box plus a small pad", () => {
    const bounds = spatialFitBounds([box("a", 0, 0), box("b", 440, 340)], 24);
    expect(bounds).toEqual({
      x: -24,
      y: -24,
      width: 440 + SPATIAL_NODE_W + 48,
      height: 340 + SPATIAL_NODE_H + 48,
    });
  });
});

describe("selectableSpatialStageIds", () => {
  it("omits pending node ids", () => {
    expect(
      selectableSpatialStageIds([
        stage({ stage_id: "a", status: "succeeded" }),
        stage({ stage_id: "b", status: "pending" }),
        stage({ stage_id: "c", status: "skipped" }),
      ]),
    ).toEqual(["a", "c"]);
  });
});

describe("envelopeEdgeEnabled", () => {
  it("is enabled only when the from-stage has an envelope", () => {
    const stages = [
      stage({
        stage_id: "a",
        status: "succeeded",
        envelope: { status: "success", summary: "ok", artifacts: ["out.md"] },
      }),
      stage({ stage_id: "b", status: "running" }),
    ];
    expect(envelopeEdgeEnabled(stages, "a")).toBe(true);
    expect(envelopeEdgeEnabled(stages, "b")).toBe(false);
  });
});

describe("fitTransform", () => {
  it("places content below and right of the 56px zoom-card inset", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const next = fitTransform(bounds, { width: 800, height: 600 });
    const left = next.panX + bounds.x * next.zoom;
    const top = next.panY + bounds.y * next.zoom;
    expect(left).toBeGreaterThanOrEqual(SPATIAL_FIT_TOOL_INSET);
    expect(top).toBeGreaterThanOrEqual(SPATIAL_FIT_TOOL_INSET);
  });

  it("returns the safe default for empty bounds or a zero viewport", () => {
    expect(fitTransform({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      panX: 0,
      panY: 0,
      zoom: 1,
    });
    expect(fitTransform({ x: 0, y: 0, width: 200, height: 100 }, { width: 0, height: 600 })).toEqual({
      panX: 0,
      panY: 0,
      zoom: 1,
    });
  });
});

describe("shouldRefitOnViewportChange", () => {
  it("refits after the first fit only when the operator has not moved", () => {
    expect(shouldRefitOnViewportChange(true, false)).toBe(true);
    expect(shouldRefitOnViewportChange(true, true)).toBe(false);
    expect(shouldRefitOnViewportChange(false, false)).toBe(false);
  });
});

describe("spatialNodeKicker", () => {
  it("hides a kicker that equals the title", () => {
    expect(spatialNodeKicker("design", "design")).toBeNull();
  });

  it("keeps a distinct kicker", () => {
    expect(spatialNodeKicker("design", "Design review")).toBe("design");
  });
});

describe("spatialNodeAction", () => {
  it("exposes Retry, not Abandon, on abandoned-display nodes", () => {
    expect(spatialNodeAction("failed", true)).toBe("retry");
  });

  it("exposes neither Retry nor Abandon on waiting nodes", () => {
    expect(spatialNodeAction("waiting_for_input", false)).toBeNull();
  });

  it("exposes Abandon on running and Retry on ordinary failed", () => {
    expect(spatialNodeAction("running", false)).toBe("abandon");
    expect(spatialNodeAction("failed", false)).toBe("retry");
  });
});
