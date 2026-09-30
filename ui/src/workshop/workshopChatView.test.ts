import { describe, expect, it } from "vitest";
import {
  maySend,
  mapWorkshopChatParts,
} from "./workshopChatView";

describe("maySend", () => {
  it("allows non-empty trimmed text", () => {
    expect(maySend("hello")).toBe(true);
    expect(maySend("  hello  ")).toBe(true);
  });

  it("rejects whitespace-only text", () => {
    expect(maySend("")).toBe(false);
    expect(maySend("   ")).toBe(false);
    expect(maySend("\n\t")).toBe(false);
  });
});

describe("mapWorkshopChatParts", () => {
  it("maps user then assistant text to bodies in role order and draft_mutation to a card", () => {
    const parts = mapWorkshopChatParts([
      {
        role: "user",
        content: [{ type: "text", text: "Add an intake stage" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Draft updated." },
          {
            type: "tool-call",
            toolCallId: "mutation-mut-1-0",
            toolName: "draft_mutation",
            args: {
              mutationId: "mut-1",
              summary: "Add stage intake",
              affectedStageIds: ["intake"],
            },
            argsText: JSON.stringify({
              mutationId: "mut-1",
              summary: "Add stage intake",
              affectedStageIds: ["intake"],
            }),
          },
        ],
      },
    ]);

    expect(parts).toEqual([
      {
        kind: "text",
        role: "user",
        text: "Add an intake stage",
      },
      {
        kind: "text",
        role: "assistant",
        text: "Draft updated.",
      },
      {
        kind: "draft_mutation",
        toolCallId: "mutation-mut-1-0",
        args: {
          mutationId: "mut-1",
          summary: "Add stage intake",
          affectedStageIds: ["intake"],
        },
      },
    ]);
  });

  it("omits tool-calls that are not draft_mutation", () => {
    const parts = mapWorkshopChatParts([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Done." },
          {
            type: "tool-call",
            toolCallId: "other-1",
            toolName: "bash",
            args: { command: "ls" },
            argsText: '{"command":"ls"}',
          },
        ],
      },
    ]);

    expect(parts).toEqual([
      { kind: "text", role: "assistant", text: "Done." },
    ]);
  });

  it("exposes Chat failed text as the only assistant body", () => {
    const parts = mapWorkshopChatParts([
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial stream…" },
          {
            type: "text",
            text: "Chat failed: host unavailable",
          },
        ],
      },
    ]);

    expect(parts).toEqual([
      {
        kind: "text",
        role: "assistant",
        text: "Chat failed: host unavailable",
      },
    ]);
  });

  it("maps plain string content to a text body and empty string to nothing", () => {
    expect(
      mapWorkshopChatParts([{ role: "user", content: "Hello from string" }]),
    ).toEqual([
      { kind: "text", role: "user", text: "Hello from string" },
    ]);
    expect(mapWorkshopChatParts([{ role: "user", content: "" }])).toEqual([]);
  });

  it("skips draft_mutation tool-calls when Chat failed text is present", () => {
    const parts = mapWorkshopChatParts([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Chat failed: host unavailable" },
          {
            type: "tool-call",
            toolCallId: "mutation-mut-1-0",
            toolName: "draft_mutation",
            args: {
              mutationId: "mut-1",
              summary: "Add stage intake",
              affectedStageIds: ["intake"],
            },
            argsText: JSON.stringify({
              mutationId: "mut-1",
              summary: "Add stage intake",
              affectedStageIds: ["intake"],
            }),
          },
        ],
      },
    ]);

    expect(parts).toEqual([
      {
        kind: "text",
        role: "assistant",
        text: "Chat failed: host unavailable",
      },
    ]);
  });
});
