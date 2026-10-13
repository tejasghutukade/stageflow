import type { WorkshopChatAttachment } from "./chatAttachments.js";
import type { WorkshopChatProposalPayload, WorkshopChatWireEvent } from "./chatTurn.js";
import {
  mutationSnapshotsFromProposals,
  type WorkshopSessionMutationSnapshot,
} from "./sessionMutations.js";
import type { WorkshopSessionAppendMessage } from "./sessionStore.js";

export function assistantTranscriptTextFromEvents(
  events: readonly WorkshopChatWireEvent[],
): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "message" && event.role === "assistant") {
      parts.push(event.text);
    }
  }
  return parts.join("\n\n").trim();
}

export function proposalPayloadsFromEvents(
  events: readonly WorkshopChatWireEvent[],
): WorkshopChatProposalPayload[] {
  const proposals: WorkshopChatProposalPayload[] = [];
  for (const event of events) {
    if (event.type === "proposal") {
      proposals.push(event.proposal);
    }
  }
  return proposals;
}

export function transcriptMessagesForTurn(
  userMessage: string,
  attachments: readonly WorkshopChatAttachment[],
  events: readonly WorkshopChatWireEvent[],
  options?: { autoApply?: boolean },
): WorkshopSessionAppendMessage[] {
  const messages: WorkshopSessionAppendMessage[] = [
    {
      role: "user",
      text: userMessage,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    },
  ];
  for (const event of events) {
    if (event.type === "message" && event.role !== "assistant") {
      messages.push({ role: event.role, text: event.text });
    }
  }
  const assistantText = assistantTranscriptTextFromEvents(events);
  const proposals = proposalPayloadsFromEvents(events);
  const mutations: WorkshopSessionMutationSnapshot[] =
    proposals.length > 0
      ? mutationSnapshotsFromProposals(proposals, options?.autoApply === true)
      : [];
  if (assistantText.length > 0 || mutations.length > 0) {
    messages.push({
      role: "assistant",
      text: assistantText,
      ...(mutations.length > 0 ? { mutations } : {}),
    });
  }
  return messages;
}
