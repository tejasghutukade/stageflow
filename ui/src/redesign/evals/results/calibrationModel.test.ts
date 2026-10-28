import { describe, expect, it } from "vitest";
import type { EvalCalibration } from "../../../api/evalTypes";
import { calibrationBadge, calibrationCurrent, calibrationView } from "./calibrationModel";

const cal: EvalCalibration = {
  id: "cal_1",
  grader_id: "polite",
  grader_hash: "h1",
  judge: "anthropic/j",
  prompt_version: 1,
  split: "all",
  candidate: false,
  stats: {
    n: 12,
    agreement: 0.75,
    cohen_kappa: 0.5,
    tpr: 0.8,
    tnr: null,
    confusion: { tp: 4, fp: 1, tn: 5, fn: 2 },
    warnings: ["low_n"],
    errored: 1,
  },
  disagreements: [{ case_id: "c2", repeat_index: 0, label: "pass", judge: "fail", reason: "too curt" }],
  cost_usd: 0.04,
  created_at: "2026-10-28T00:00:00Z",
};

describe("calibrationView", () => {
  it("formats the stats the API returned without recomputing them", () => {
    const v = calibrationView(cal);
    expect(v.headline).toBe("12 labels · agreement 0.75 · kappa 0.50");
    expect(v.rows[0]).toEqual({ label: "Judge passes when you pass", value: "0.80" });
    expect(v.rows[1]).toEqual({ label: "Judge fails when you fail", value: "n/a" });
    expect(v.rows.some((r) => r.label.startsWith("Judge errors"))).toBe(true);
    expect(v.warnings).toHaveLength(1);
    expect(v.disagreements[0]).toMatchObject({ key: "c2#0", text: "You pass, judge fail", reason: "too curt" });
  });
});

describe("stability row", () => {
  it("shows the flip rate only when it was measured", () => {
    expect(calibrationView(cal).rows.some((r) => r.label.startsWith("Judge changes"))).toBe(false);
    const measured = { ...cal, stats: { ...cal.stats, stability: { k: 3, n: 8, unstable: 2, flip_rate: 0.25 } } };
    const row = calibrationView(measured).rows.find((r) => r.label.startsWith("Judge changes"));
    expect(row).toEqual({ label: "Judge changes its mind (3 calls each)", value: "0.25 (2 of 8)" });
  });
});

describe("calibration badge", () => {
  it("is current only for the same grader hash and judge, never for a candidate", () => {
    expect(calibrationCurrent(cal, "h1", "anthropic/j")).toBe(true);
    expect(calibrationCurrent(cal, "h2", "anthropic/j")).toBe(false);
    expect(calibrationCurrent(cal, "h1", "anthropic/other")).toBe(false);
    expect(calibrationCurrent({ ...cal, candidate: true }, "h1", "anthropic/j")).toBe(false);
    expect(calibrationCurrent(null, "h1", "anthropic/j")).toBe(false);
    expect(calibrationCurrent(cal, null, null)).toBe(false);
    expect(calibrationCurrent(cal, "h1", null)).toBe(true);
  });

  it("labels the states", () => {
    expect(calibrationBadge(null, false)).toBe("Not calibrated");
    expect(calibrationBadge(cal, true)).toBe("Calibrated: kappa 0.50 on 12 labels");
    expect(calibrationBadge(cal, false)).toBe("Out of date: kappa 0.50 on 12 labels");
  });
});
