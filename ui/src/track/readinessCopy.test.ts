import { describe, expect, it } from "vitest";
import { readinessDetail } from "./readinessCopy";

describe("readinessDetail", () => {
  it("describes blocked stages with waits-on copy when labels are provided", () => {
    expect(
      readinessDetail({
        readiness: "blocked",
        blocked_by: ["improve-b"],
        status: "pending",
        blockersLabel: (id) => id,
      }),
    ).toBe("waits on improve-b");
  });

  it("lists every unresolved parent in waits-on copy", () => {
    expect(
      readinessDetail({
        readiness: "blocked",
        blocked_by: ["research", "validation"],
        status: "pending",
        blockersLabel: (id) => id,
      }),
    ).toBe("waits on research, validation");
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

  it("omits duplicate interrupted copy when status is interrupted", () => {
    expect(
      readinessDetail({
        readiness: "interrupted",
        status: "interrupted",
      }),
    ).toBeUndefined();
  });
});
