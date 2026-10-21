import { describe, expect, it } from "vitest";
import { inboxPath, parseInboxTabFromHash } from "./inboxTab";

describe("inboxTab", () => {
  it("defaults to needs", () => {
    expect(parseInboxTabFromHash("#/inbox")).toBe("needs");
    expect(inboxPath("needs")).toBe("/inbox");
  });

  it("parses failed and done_today", () => {
    expect(parseInboxTabFromHash("#/inbox?tab=failed")).toBe("failed");
    expect(parseInboxTabFromHash("#/inbox?tab=done_today")).toBe("done_today");
    expect(inboxPath("failed")).toBe("/inbox?tab=failed");
  });
});
