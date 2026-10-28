import type { TextMessagePart, ToolCallMessagePart } from "@assistant-ui/react";
import type { GuideMessageRecord, GuidePart, GuideToolFrame } from "./api";

export type GuideContentPart = TextMessagePart | ToolCallMessagePart;

type ToolState = Pick<GuideToolFrame, "id" | "name" | "status" | "args" | "result" | "error">;

export function toolCallPart(tool: ToolState): ToolCallMessagePart {
  const args = (tool.args ?? {}) as ToolCallMessagePart["args"];
  const base = { type: "tool-call" as const, toolCallId: tool.id, toolName: tool.name, args, argsText: JSON.stringify(args) };
  if (tool.status === "running") return base;
  if (tool.status === "error") return { ...base, isError: true, result: tool.error ?? tool.result ?? null };
  return { ...base, result: tool.result === undefined ? null : tool.result };
}

/** Folds one streamed delta or tool frame into the reply content, keeping arrival order. */
export function applyGuideFrame(
  content: readonly GuideContentPart[],
  frame: { type: "delta"; text: string } | GuideToolFrame,
): GuideContentPart[] {
  if (frame.type === "delta") {
    const last = content.at(-1);
    if (last?.type === "text") return [...content.slice(0, -1), { type: "text", text: last.text + frame.text }];
    return [...content, { type: "text", text: frame.text }];
  }
  const part = toolCallPart(frame);
  const index = content.findIndex((item) => item.type === "tool-call" && item.toolCallId === frame.id);
  if (index < 0) return [...content, part];
  const previous = content[index] as ToolCallMessagePart;
  const merged = frame.args ? part : { ...part, args: previous.args, argsText: previous.argsText };
  return content.map((item, i) => (i === index ? merged : item));
}

export function guidePartsToContent(parts: readonly GuidePart[]): GuideContentPart[] {
  return parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : toolCallPart(part)));
}

/** Content for a finished assistant message: stored parts win, else what was streamed, else its text. */
export function finalGuideContent(message: GuideMessageRecord, streamed: readonly GuideContentPart[]): GuideContentPart[] {
  if (message.parts?.length) return guidePartsToContent(message.parts);
  if (streamed.some((part) => part.type === "tool-call")) return [...streamed];
  return [{ type: "text", text: message.text }];
}
