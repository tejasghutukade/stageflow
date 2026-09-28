import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage } from "./draft";

export type AppendTextSource = {
  content: readonly { type: string; text?: string }[];
};

export function convertChatMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
  };
}

export function extractAppendText(message: AppendTextSource): string | null {
  const part = message.content.find((p) => p.type === "text");
  if (!part || typeof part.text !== "string") return null;
  const text = part.text.trim();
  return text.length > 0 ? text : null;
}
