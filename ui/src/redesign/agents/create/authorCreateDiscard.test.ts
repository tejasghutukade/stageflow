import { describe, expect, it } from "vitest";
import { authorCreateDraftHasWork, planAuthorCreateDiscard } from "./authorCreateDiscard";

describe("authorCreateDraftHasWork", () => {
  it("is false for an empty shell", () => {
    expect(authorCreateDraftHasWork({ name: "", instructions: "", description: "" }, 0)).toBe(false);
  });

  it("is true when the transcript or draft fields have work", () => {
    expect(authorCreateDraftHasWork({}, 1)).toBe(true);
    expect(authorCreateDraftHasWork({ name: "Scout" }, 0)).toBe(true);
    expect(authorCreateDraftHasWork({ instructions: "Search." }, 0)).toBe(true);
    expect(authorCreateDraftHasWork({ description: "Finds things" }, 0)).toBe(true);
  });
});

describe("planAuthorCreateDiscard", () => {
  it("navigates only when there is no session", () => {
    expect(
      planAuthorCreateDiscard({
        definition: { name: "Scout" },
        transcriptMessages: 2,
      }),
    ).toEqual({ action: "navigate" });
  });

  it("deletes without confirm for an empty session shell", () => {
    expect(
      planAuthorCreateDiscard({
        sessionId: "sess-1",
        definition: { name: "", instructions: "" },
        transcriptMessages: 0,
      }),
    ).toEqual({ action: "delete", sessionId: "sess-1", confirm: false });
  });

  it("requires confirm when the draft has work", () => {
    expect(
      planAuthorCreateDiscard({
        sessionId: "sess-1",
        definition: { name: "Scout" },
        transcriptMessages: 0,
      }),
    ).toEqual({ action: "delete", sessionId: "sess-1", confirm: true });
    expect(
      planAuthorCreateDiscard({
        sessionId: "sess-1",
        definition: {},
        transcriptMessages: 2,
      }),
    ).toEqual({ action: "delete", sessionId: "sess-1", confirm: true });
  });
});
