import { describe, expect, it } from "vitest";
import { createClaudeActivityMapper } from "../src/agent/claudeActivity.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function assistantMessage(content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    message: { content },
    parent_tool_use_id: null,
    uuid: "u1",
    session_id: "s1",
  } as unknown as SDKMessage;
}

function userMessage(content: unknown[]): SDKMessage {
  return {
    type: "user",
    message: { content },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

describe("createClaudeActivityMapper", () => {
  it("maps assistant text blocks to message events", () => {
    const mapper = createClaudeActivityMapper();
    const events = mapper.map(
      assistantMessage([{ type: "text", text: "hello there" }]),
    );
    expect(events).toEqual([
      { event: "message", role: "assistant", text: "hello there" },
    ]);
  });

  it("maps assistant tool_use blocks to tool_start", () => {
    const mapper = createClaudeActivityMapper();
    const events = mapper.map(
      assistantMessage([
        { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } },
      ]),
    );
    expect(events).toEqual([
      {
        event: "tool_start",
        toolName: "Read",
        toolCallId: "call_1",
        argsPreview: JSON.stringify({ path: "a.ts" }),
      },
    ]);
  });

  it("correlates a later tool_result with the tool_use name seen earlier", () => {
    const mapper = createClaudeActivityMapper();
    mapper.map(
      assistantMessage([
        { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
      ]),
    );
    const events = mapper.map(
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "file1\nfile2",
          is_error: false,
        },
      ]),
    );
    expect(events).toEqual([
      {
        event: "tool_end",
        toolName: "Bash",
        toolCallId: "call_1",
        isError: false,
        resultPreview: "file1\nfile2",
      },
    ]);
  });

  it("falls back to 'unknown' for a tool_result whose tool_use was never observed", () => {
    const mapper = createClaudeActivityMapper();
    const events = mapper.map(
      userMessage([
        { type: "tool_result", tool_use_id: "call_missing", content: "x" },
      ]),
    );
    expect(events).toEqual([
      {
        event: "tool_end",
        toolName: "unknown",
        toolCallId: "call_missing",
        isError: false,
        resultPreview: "x",
      },
    ]);
  });

  it("forgets a tool_use id once its result has been consumed", () => {
    const mapper = createClaudeActivityMapper();
    mapper.map(
      assistantMessage([{ type: "tool_use", id: "call_1", name: "Read", input: {} }]),
    );
    mapper.map(
      userMessage([{ type: "tool_result", tool_use_id: "call_1", content: "ok" }]),
    );
    const events = mapper.map(
      userMessage([{ type: "tool_result", tool_use_id: "call_1", content: "again" }]),
    );
    expect(events[0]?.event === "tool_end" && events[0].toolName).toBe("unknown");
  });

  it("ignores system and result messages", () => {
    const mapper = createClaudeActivityMapper();
    const events = mapper.map({ type: "result" } as unknown as SDKMessage);
    expect(events).toEqual([]);
  });
});
