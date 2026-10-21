import { describe, expect, it } from "vitest";
import { workshopChatThreadRemountKey } from "./workshopChatThreadRemountKey";

describe("workshopChatThreadRemountKey", () => {
  it("stays stable across lazy session bind at the same epoch", () => {
    const beforeSession = workshopChatThreadRemountKey(0);
    const afterSession = workshopChatThreadRemountKey(0);
    expect(beforeSession).toBe(afterSession);
    expect(beforeSession).not.toMatch(/draft|sess-/);
  });

  it("changes only when threadEpoch bumps", () => {
    expect(workshopChatThreadRemountKey(0)).not.toBe(workshopChatThreadRemountKey(1));
  });

  it("must not match the old sessionId:epoch remount pattern", () => {
    expect(workshopChatThreadRemountKey(0)).not.toBe("draft:0");
    expect(workshopChatThreadRemountKey(0)).not.toBe("sess-new:0");
  });
});
