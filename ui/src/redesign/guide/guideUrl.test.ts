import { describe, expect, it } from "vitest";
import { guidePath } from "../../routes";
import { guideUrlAfterNewChat, guideUrlAfterSession } from "./guideUrl";

describe("guideUrl helpers", () => {
  it("builds chat URLs for session restore and new chat", () => {
    expect(guidePath("chat", guideUrlAfterSession("thread-1"))).toBe(
      "/guide?session=thread-1",
    );
    expect(guidePath("chat", guideUrlAfterNewChat())).toBe("/guide");
  });
});
