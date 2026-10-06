import { describe, expect, it } from "vitest";
import { runGoalFromTaskYaml } from "./runTaskGoal";

describe("runGoalFromTaskYaml", () => {
  it("reads a plain goal line", () => {
    expect(runGoalFromTaskYaml("goal: Fix login redirect\nid: x\n")).toBe(
      "Fix login redirect",
    );
  });

  it("reads quoted goals and skips comments", () => {
    expect(
      runGoalFromTaskYaml("# header\ngoal: \"OAuth callback bug\"\n"),
    ).toBe("OAuth callback bug");
  });

  it("returns null when missing", () => {
    expect(runGoalFromTaskYaml("id: only\n")).toBeNull();
    expect(runGoalFromTaskYaml("")).toBeNull();
  });
});
