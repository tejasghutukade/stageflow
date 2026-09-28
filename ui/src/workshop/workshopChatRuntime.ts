import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  WORKSHOP_PROPOSAL_TOOL_NAME,
  type ChatMessage,
  type WorkshopProposalToolArgs,
  type WorkshopProposalToolResult,
} from "./draft";

export type AppendTextSource = {
  content: readonly { type: string; text?: string }[];
};

export type ConvertChatMessageOptions = {
  /** Active pending proposal id, if any — drives tool-call settled vs interactive. */
  pendingId?: string | null;
};

export function convertChatMessage(
  message: ChatMessage,
  options: ConvertChatMessageOptions = {},
): ThreadMessageLike {
  const content: Exclude<ThreadMessageLike["content"], string> = [
    { type: "text", text: message.text },
  ];

  if (message.proposalId) {
    const args: WorkshopProposalToolArgs = {
      proposalId: message.proposalId,
      summary: message.proposalSummary ?? message.text,
      artifacts: message.artifacts ?? [],
    };
    const pendingId = options.pendingId ?? null;
    const settled = pendingId !== message.proposalId;
    const result: WorkshopProposalToolResult | undefined = settled
      ? { status: "settled" }
      : undefined;
    content.push({
      type: "tool-call",
      toolCallId: message.proposalId,
      toolName: WORKSHOP_PROPOSAL_TOOL_NAME,
      args,
      ...(result ? { result } : {}),
    });
  }

  return {
    id: message.id,
    role: message.role,
    content,
  };
}

export function extractAppendText(message: AppendTextSource): string | null {
  const part = message.content.find((p) => p.type === "text");
  if (!part || typeof part.text !== "string") return null;
  const text = part.text.trim();
  return text.length > 0 ? text : null;
}
