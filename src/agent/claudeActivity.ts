/**
 * Claude Agent SDK message → Pi-agnostic StageActivityEvent mapping.
 *
 * `tool_result` blocks in the Anthropic Messages API carry only a
 * `tool_use_id`, not the tool name, so this mapper is stateful: it remembers
 * the name for each in-flight tool_use id (set on `tool_start`, consumed on
 * `tool_end`) the same way Pi's own session already tracks call/response
 * pairing internally.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { truncateActivityText, type StageActivityEvent } from "./activity.js";

type ContentBlock = Record<string, unknown> & { type?: string };

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ContentBlock => block !== null && typeof block === "object",
  );
}

export type ClaudeActivityMapper = {
  map(message: SDKMessage): StageActivityEvent[];
};

export function createClaudeActivityMapper(): ClaudeActivityMapper {
  const toolNameById = new Map<string, string>();

  function map(message: SDKMessage): StageActivityEvent[] {
    if (message.type === "assistant") {
      const events: StageActivityEvent[] = [];
      for (const block of contentBlocks(message.message.content)) {
        if (block.type === "text" && typeof block.text === "string") {
          events.push({
            event: "message",
            role: "assistant",
            text: truncateActivityText(block.text),
          });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const toolCallId = typeof block.id === "string" ? block.id : undefined;
          if (toolCallId) {
            toolNameById.set(toolCallId, block.name);
          }
          events.push({
            event: "tool_start",
            toolName: block.name,
            toolCallId,
            argsPreview: truncateActivityText(block.input),
          });
        }
      }
      return events;
    }

    if (message.type === "user") {
      const events: StageActivityEvent[] = [];
      for (const block of contentBlocks(message.message.content)) {
        if (block.type !== "tool_result") continue;
        const toolCallId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const toolName =
          (toolCallId ? toolNameById.get(toolCallId) : undefined) ?? "unknown";
        if (toolCallId) {
          toolNameById.delete(toolCallId);
        }
        events.push({
          event: "tool_end",
          toolName,
          toolCallId,
          isError: Boolean(block.is_error),
          resultPreview: truncateActivityText(block.content),
        });
      }
      return events;
    }

    return [];
  }

  return { map };
}
