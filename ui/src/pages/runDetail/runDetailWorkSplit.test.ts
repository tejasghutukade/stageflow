import { describe, expect, it } from "vitest";
import { clampWorkHeight, UPPER_MIN_H, WORK_MIN_H } from "./runDetailWorkSplit";

describe("clampWorkHeight", () => {
  it("clamps between work min and pane minus upper min", () => {
    const pane = 800;
    expect(clampWorkHeight(100, pane)).toBe(WORK_MIN_H);
    expect(clampWorkHeight(9999, pane)).toBe(pane - UPPER_MIN_H);
    expect(clampWorkHeight(350, pane)).toBe(350);
  });

  it("caps lower band on short panes without enforcing work min", () => {
    const pane = 300;
    expect(clampWorkHeight(500, pane)).toBe(pane - UPPER_MIN_H);
  });
});
