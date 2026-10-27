import { describe, expect, it } from "vitest";
import { agentCreateRemountKey } from "./agentCreateRemountKey";

describe("agentCreateRemountKey", () => {
  it("uses new when there is no session", () => {
    expect(agentCreateRemountKey(undefined)).toBe("new");
  });

  it("uses the session id so A→B remounts", () => {
    expect(agentCreateRemountKey("draft-a")).toBe("draft-a");
    expect(agentCreateRemountKey("draft-a")).not.toBe(agentCreateRemountKey("draft-b"));
    expect(agentCreateRemountKey("draft-a")).not.toBe(agentCreateRemountKey(undefined));
  });
});
