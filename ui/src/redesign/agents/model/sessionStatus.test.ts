import { describe, expect, it } from "vitest";
import { sessionStatusView } from "./sessionStatus";

describe("session status view", () => {
  it("shows live state before the last run's outcome", () => {
    expect(sessionStatusView({ status: "waiting", lastTurnStatus: "succeeded" }).label).toBe("Waiting on you");
    expect(sessionStatusView({ status: "running", lastTurnStatus: null }).label).toBe("Running");
  });

  it("falls back to how the latest run ended", () => {
    expect(sessionStatusView({ status: "open", lastTurnStatus: "succeeded" }).label).toBe("Succeeded");
    expect(sessionStatusView({ status: "open", lastTurnStatus: "failed" }).label).toBe("Failed");
    expect(sessionStatusView({ status: "closed", lastTurnStatus: "cancelled" }).label).toBe("Stopped");
    expect(sessionStatusView({ status: "open", lastTurnStatus: null }).label).toBe("No runs");
  });
});
