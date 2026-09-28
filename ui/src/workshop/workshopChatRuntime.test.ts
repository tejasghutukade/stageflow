import { describe, expect, it } from "vitest";
import {
  convertChatMessage,
  extractAppendText,
} from "./workshopChatRuntime";
import type { ChatMessage } from "./draft";

describe("workshopChatRuntime", () => {
  it("maps ChatMessage roles and text into ThreadMessageLike", () => {
    const messages: ChatMessage[] = [
      { id: "a1", role: "assistant", text: "Hello **world**" },
      { id: "u1", role: "user", text: "add a stage" },
      { id: "s1", role: "system", text: "Accepted: stage foo" },
    ];
    expect(messages.map(convertChatMessage)).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Hello **world**" }],
      },
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "add a stage" }],
      },
      {
        id: "s1",
        role: "system",
        content: [{ type: "text", text: "Accepted: stage foo" }],
      },
    ]);
  });

  it("extracts trimmed text from AppendMessage for onNew → parent send", () => {
    expect(
      extractAppendText({
        content: [{ type: "text", text: "  propose a stage  " }],
      }),
    ).toBe("propose a stage");
    expect(
      extractAppendText({ content: [{ type: "text", text: "   " }] }),
    ).toBeNull();
    expect(extractAppendText({ content: [] })).toBeNull();
  });
});
