import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPH_VIEW, fitGraphView, stepZoom } from "./graphViewport";

describe("stepZoom", () => {
  it("moves in 10% steps within 50–200%", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.1);
    expect(stepZoom(1, -1)).toBeCloseTo(0.9);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.73, 1)).toBeCloseTo(0.8);
  });
});

describe("fitGraphView", () => {
  it("shrinks a tall graph to the largest 10% step that fits", () => {
    expect(fitGraphView({ width: 432, height: 900 }, { width: 524, height: 500 })).toEqual({
      zoom: 0.5,
      panX: 0,
      panY: 0,
    });
    expect(fitGraphView({ width: 432, height: 400 }, { width: 524, height: 452 })).toEqual({
      zoom: 1,
      panX: 0,
      panY: 0,
    });
  });

  it("grows a small graph and centers it vertically", () => {
    const view = fitGraphView({ width: 208, height: 60 }, { width: 524, height: 452 });
    expect(view.zoom).toBe(2);
    expect(view.panY).toBe(140);
  });

  it("resets for empty content", () => {
    expect(fitGraphView({ width: 0, height: 0 }, { width: 500, height: 500 })).toBe(DEFAULT_GRAPH_VIEW);
  });
});
