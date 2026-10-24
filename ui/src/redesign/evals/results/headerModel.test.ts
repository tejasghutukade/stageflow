import { describe, expect, it } from "vitest";
import { fixtureRun } from "./fixtures";
import {
  footerText,
  headerSubtitle,
  previousRunNumber,
  resultChip,
  resultsTabs,
  runPosition,
  suiteTypeLabel,
} from "./headerModel";

describe("headerModel", () => {
  it("builds the passed chip from stats and threshold", () => {
    expect(resultChip(fixtureRun())).toEqual({ text: "Passed · 87.5% vs 80% threshold", tone: "ok" });
  });

  it("builds the below-threshold chip", () => {
    const run = fixtureRun({ passed: false });
    run.stats!.pass_rate = 0.783;
    expect(resultChip(run)).toEqual({ text: "Below threshold · 78.3% vs 80%", tone: "fail" });
  });

  it("uses the status for incomplete runs", () => {
    expect(resultChip(fixtureRun({ status: "budget_stopped" })).text).toBe("Stopped at cost limit");
    expect(resultChip(fixtureRun({ status: "failed" }))).toEqual({ text: "Failed", tone: "fail" });
    expect(resultChip(fixtureRun({ status: "cancelled" })).tone).toBe("needs");
  });

  it("builds the subtitle", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(headerSubtitle(fixtureRun(), now)).toBe(
      "Stage review in feature-ship · review-diffs, 24 cases × 3 repeats · judge anthropic/claude-sonnet-4-5 · finished 2h ago in 3 m 41 s",
    );
  });

  it("omits finished and judge parts when absent", () => {
    const run = fixtureRun({ finished_at: null });
    run.config.settings.judge = "";
    run.config.target = { file: "stages/x.yaml" };
    expect(headerSubtitle(run, 0)).toBe("Stage stages/x.yaml · review-diffs, 24 cases × 3 repeats");
  });

  it("finds neighbours and position", () => {
    expect(previousRunNumber([1, 2, 5, 14], 14)).toBe(5);
    expect(previousRunNumber([1, 2], 1)).toBeNull();
    expect(runPosition([13, 14], 14)).toEqual({ label: "Run #14 of 14", previous: 13, next: null });
    expect(runPosition([], 3).label).toBe("Run #3 of 3");
    expect(runPosition([1, 2, 3], 1).next).toBe(2);
  });

  it("builds tabs with counts and the footer", () => {
    const tabs = resultsTabs(fixtureRun(), null);
    expect(tabs.map((t) => [t.id, t.count])).toEqual([
      ["overview", undefined],
      ["cases", 24],
      ["graders", 5],
      ["config", undefined],
    ]);
    expect(resultsTabs(fixtureRun(), 7)[1]!.count).toBe(7);
    expect(footerText(fixtureRun())).toBe(
      "Stage version 3f9a1c · eval file evals/review-findings.eval.yaml · stored on this machine",
    );
    expect(suiteTypeLabel(fixtureRun())).toBe("Capability");
  });
});
