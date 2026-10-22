import { describe, expect, it } from "vitest";
import { NO_SESSIONS, addSessionsLabel, sessionMeta } from "./candidatesModel";

describe("session candidates", () => {
  it("labels the confirm button", () => {
    expect(addSessionsLabel(0)).toBe("Add scenarios");
    expect(addSessionsLabel(1)).toBe("Use 1 session as scenarios");
    expect(addSessionsLabel(4)).toBe("Use 4 sessions as scenarios");
  });

  it("shows turns and the tools a session called", () => {
    expect(sessionMeta({ turns: 3, tools: ["orders.get_status", "billing.lookup"] })).toBe("3 turns · tools orders.get_status, billing.lookup");
    expect(sessionMeta({ turns: 1, tools: [] })).toBe("1 turn");
  });

  it("says when there is nothing to pick", () => {
    expect(NO_SESSIONS).toBe("No finished sessions of this agent yet.");
  });
});
