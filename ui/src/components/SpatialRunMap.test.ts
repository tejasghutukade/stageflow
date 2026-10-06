import { describe, expect, it } from "vitest";
import type { StageSnapshot } from "../api";
import {
  SPATIAL_COL_W,
  SPATIAL_NODE_H,
  SPATIAL_NODE_W,
  type SpatialNodeBox,
} from "../track/layoutPipelineTrack";
import {
  PAN_CLICK_THRESHOLD_PX,
  SPATIAL_FIT_TOOL_INSET,
  FEEDBACK_LANE_STAGGER,
  FEEDBACK_OVERLAY_CLEAR,
  envelopeEdgeEnabled,
  feedbackOverlayExtent,
  feedbackOverlayLaneExtra,
  feedbackOverlayPath,
  feedbackPathPoints,
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
    const bounds = spatialFitBounds([box("a", 0, 0), box("b", SPATIAL_COL_W, 340)], 24);
    expect(bounds).toEqual({
      x: -24,
      y: -24,
      width: SPATIAL_COL_W + SPATIAL_NODE_W + 48,
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

  it("joins a clone kicker against its ordinal title", () => {
    expect(spatialNodeKicker("author-diagrams", "author-diagrams · 2")).toBe(
      "author-diagrams",
    );
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

describe("feedbackOverlayPath", () => {
  it("routes same-row reverse review→implement as an orthogonal U-lane below the band", () => {
    const implement = box("implement", SPATIAL_COL_W, 0);
    const review = box("review", SPATIAL_COL_W * 2, 0);
    const path = feedbackOverlayPath(review, implement);
    const bandBottom = Math.max(review.y + review.height, implement.y + implement.height);
    const points = feedbackPathPoints(path);
    expect(path).toMatch(/^M[\d.]+ [\d.]+ V[\d.]+ H[\d.]+ V[\d.]+$/);
    expect(path.includes("C")).toBe(false);
    expect(points).toHaveLength(4);
    const laneY = points[1]!.y;
    expect(laneY).toBe(bandBottom + FEEDBACK_OVERLAY_CLEAR + feedbackOverlayLaneExtra(review, implement));
    expect(points[1]!.x).toBe(points[0]!.x);
    expect(points[2]!.y).toBe(laneY);
    expect(points[2]!.x).toBe(points[3]!.x);
    expect(points[3]!.x).toBe(implement.x + implement.width / 2);
    expect(points[3]!.y).toBe(implement.y + implement.height);
    for (const p of points) {
      expect(p.y).toBeGreaterThanOrEqual(bandBottom);
    }
  });

  it("clears the implement band on skip-column review→plan with a deeper lane", () => {
    const plan = box("plan", 0, 0);
    const implement = box("implement", SPATIAL_COL_W, 0);
    const review = box("review", SPATIAL_COL_W * 2, 0);
    const toImplement = feedbackOverlayPath(review, implement);
    const toPlan = feedbackOverlayPath(review, plan);
    const bandBottom = implement.y + implement.height;
    const planPoints = feedbackPathPoints(toPlan);
    const implPoints = feedbackPathPoints(toImplement);
    expect(toPlan).toMatch(/^M[\d.]+ [\d.]+ V[\d.]+ H[\d.]+ V[\d.]+$/);
    const planLaneY = planPoints[1]!.y;
    const implLaneY = implPoints[1]!.y;
    expect(planLaneY).toBeGreaterThan(implLaneY);
    expect(planLaneY - implLaneY).toBe(FEEDBACK_LANE_STAGGER);
    expect(planLaneY).toBeGreaterThanOrEqual(bandBottom + FEEDBACK_OVERLAY_CLEAR);
    expect(planPoints[1]!.y).toBe(planPoints[2]!.y);
    const laneMinX = Math.min(planPoints[1]!.x, planPoints[2]!.x);
    const laneMaxX = Math.max(planPoints[1]!.x, planPoints[2]!.x);
    expect(laneMinX).toBeLessThanOrEqual(implement.x);
    expect(laneMaxX).toBeGreaterThanOrEqual(implement.x + implement.width);
    expect(planLaneY).toBeGreaterThanOrEqual(bandBottom);
  });

  it("includes the orthogonal U-lane in feedback overlay extent for fit bounds", () => {
    const implement = box("implement", SPATIAL_COL_W, 0);
    const review = box("review", SPATIAL_COL_W * 2, 0);
    const extent = feedbackOverlayExtent(review, implement);
    expect(extent.y + extent.height).toBeGreaterThanOrEqual(
      review.y + review.height + FEEDBACK_OVERLAY_CLEAR,
    );
    const fitted = spatialFitBounds([implement, review, extent]);
    expect(fitted.y + fitted.height).toBeGreaterThan(
      spatialFitBounds([implement, review]).y + spatialFitBounds([implement, review]).height,
    );
  });
});