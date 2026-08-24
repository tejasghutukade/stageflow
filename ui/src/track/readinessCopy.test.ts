import { describe, expect, it } from "vitest";
import { readinessDetail } from "./readinessCopy";

describe("readinessDetail", () => {
  it("describes blocked stages with the first blocker", () => {
    expect(
      readinessDetail({
        readiness: "blocked",
        blocked_by: ["improve-b"],
        status: "pending",
      }),
    ).toBe("Blocked on improve-b");
  });

  it("returns Skipped for skipped readiness", () => {
    expect(
      readinessDetail({
        readiness: "skipped",
        status: "pending",
      }),
    ).toBe("Skipped");
  });

  it("returns Ready for ready readiness", () => {
    expect(
      readinessDetail({
        readiness: "ready",
        status: "pending",
      }),
    ).toBe("Ready");
  });

  it("omits duplicate waiting copy when status is waiting_for_input", () => {
    expect(
      readinessDetail({
        readiness: "waiting",
        status: "waiting_for_input",
      }),
    ).toBeUndefined();
  });
});
