import { describe, expect, it } from "vitest";
import { calibrationSplitOf, computeCalibration, computeStability, type CalibrationSample } from "../src/evals/stats.js";

function samples(tp: number, fp: number, tn: number, fn: number): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  let i = 0;
  const add = (count: number, label: boolean, judge: boolean) => {
    for (let k = 0; k < count; k++) out.push({ caseId: `c${i++}`, repeatIndex: 0, label, judge });
  };
  add(tp, true, true);
  add(fp, false, true);
  add(tn, false, false);
  add(fn, true, false);
  return out;
}

describe("computeCalibration", () => {
  it("matches a hand-computed kappa", () => {
    // tp 20, fp 5, tn 15, fn 10: n 50, po 0.7, judge pass 25, label pass 30
    // pe = (25*30 + 25*20) / 2500 = 0.5, kappa = 0.2 / 0.5 = 0.4
    const s = computeCalibration(samples(20, 5, 15, 10));
    expect(s.n).toBe(50);
    expect(s.agreement).toBeCloseTo(0.7, 10);
    expect(s.cohen_kappa).toBeCloseTo(0.4, 10);
    expect(s.tpr).toBeCloseTo(20 / 30, 10);
    expect(s.tnr).toBeCloseTo(15 / 20, 10);
    expect(s.confusion).toEqual({ tp: 20, fp: 5, tn: 15, fn: 10 });
    expect(s.warnings).toEqual([]);
  });

  it("is 1 for perfect agreement", () => {
    expect(computeCalibration(samples(10, 0, 10, 0)).cohen_kappa).toBe(1);
  });

  it("is null with no variance and warns", () => {
    const s = computeCalibration(samples(25, 0, 0, 0));
    expect(s.cohen_kappa).toBeNull();
    expect(s.warnings).toContain("no_variance");
    expect(s.warnings).toContain("imbalanced");
  });

  it("handles no samples", () => {
    const s = computeCalibration([]);
    expect(s).toMatchObject({ n: 0, agreement: null, cohen_kappa: null, tpr: null, tnr: null });
    expect(s.warnings).toContain("low_n");
  });

  it("warns below 20 labels", () => {
    expect(computeCalibration(samples(5, 0, 5, 0)).warnings).toContain("low_n");
  });
});

describe("calibrationSplitOf", () => {
  it("is stable and roughly 70/30", () => {
    expect(calibrationSplitOf("a")).toBe(calibrationSplitOf("a"));
    let dev = 0;
    for (let i = 0; i < 1000; i++) if (calibrationSplitOf(`case-${i}`) === "dev") dev++;
    expect(dev).toBeGreaterThan(640);
    expect(dev).toBeLessThan(760);
  });
});

describe("computeStability", () => {
  it("counts outputs with a split vote", () => {
    expect(computeStability([[true, true, true], [true, false, true], [false, false]], 3)).toEqual({
      k: 3,
      n: 3,
      unstable: 1,
      flip_rate: 1 / 3,
    });
  });

  it("ignores outputs with fewer than two valid votes and handles none", () => {
    expect(computeStability([[true], []], 3)).toEqual({ k: 3, n: 0, unstable: 0, flip_rate: null });
  });
});
