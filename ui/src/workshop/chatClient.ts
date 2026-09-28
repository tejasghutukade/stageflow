import type {
  WorkshopChatProposalPayload,
  WorkshopChatTurnPayload,
  WorkshopChatWireEvent,
} from "../api/types";
import type {
  ChatMessage,
  DraftPackage,
  ProposalArtifactDiff,
  WorkshopProposal,
} from "./draft";

export type ApplyWorkshopChatTurnInput = {
  turn: WorkshopChatTurnPayload;
  nextMessageId: () => string;
};

export type ApplyWorkshopChatTurnResult = {
  messages: ChatMessage[];
  pending: WorkshopProposal | null;
  draft: DraftPackage;
  autoApply: boolean;
};

function asDraftPackage(value: unknown): DraftPackage {
  return value as DraftPackage;
}

export function toWorkshopProposal(
  payload: WorkshopChatProposalPayload,
): WorkshopProposal {
  return {
    id: payload.id,
    summary: payload.summary,
    nextDraft: asDraftPackage(payload.nextDraft),
    baseDraft: asDraftPackage(payload.baseDraft),
    baseFingerprint: payload.baseFingerprint,
    artifacts: (payload.artifacts ?? []) as ProposalArtifactDiff[],
    affectedStageIds: payload.affectedStageIds ?? [],
  };
}

/**
 * Map Operator Agent Host wire events into Workshop chat messages + pending proposal.
 * Proposal cards attach to the assistant message when not auto-applied.
 */
export function applyWorkshopChatTurn(
  input: ApplyWorkshopChatTurnInput,
): ApplyWorkshopChatTurnResult {
  const { turn, nextMessageId } = input;
  const messages: ChatMessage[] = [];
  let pendingProposal: WorkshopChatProposalPayload | null = turn.pending;
  let autoAppliedArtifacts: ProposalArtifactDiff[] | undefined;

  for (const event of turn.events) {
    if (event.type === "message") {
      messages.push({
        id: nextMessageId(),
        role: event.role,
        text: event.text,
      });
      continue;
    }
    if (event.type === "error") {
      messages.push({
        id: nextMessageId(),
        role: "system",
        text: event.message,
      });
      continue;
    }
    if (event.type === "proposal") {
      if (event.autoApplied) {
        autoAppliedArtifacts = (event.proposal.artifacts ??
          []) as ProposalArtifactDiff[];
        pendingProposal = null;
      } else {
        pendingProposal = event.proposal;
      }
    }
  }

  if (pendingProposal) {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      lastAssistant.proposalId = pendingProposal.id;
      lastAssistant.proposalSummary = pendingProposal.summary;
      lastAssistant.artifacts = (pendingProposal.artifacts ??
        []) as ProposalArtifactDiff[];
    } else {
      messages.push({
        id: nextMessageId(),
        role: "assistant",
        text: pendingProposal.summary,
        proposalId: pendingProposal.id,
        proposalSummary: pendingProposal.summary,
        artifacts: (pendingProposal.artifacts ?? []) as ProposalArtifactDiff[],
      });
    }
  } else if (autoAppliedArtifacts?.length) {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      lastAssistant.artifacts = autoAppliedArtifacts;
    }
  }

  return {
    messages,
    pending: pendingProposal ? toWorkshopProposal(pendingProposal) : null,
    draft: asDraftPackage(turn.draft),
    autoApply: turn.autoApply,
  };
}

/** Build ChatMessage list from streamed deltas + final turn (tests / progressive UI). */
export function assistantMessageFromDeltas(
  deltas: string[],
  id: string,
): ChatMessage {
  return {
    id,
    role: "assistant",
    text: deltas.join(""),
  };
}

export function isWorkshopChatWireEvent(
  value: unknown,
): value is WorkshopChatWireEvent {
  if (value === null || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "message" ||
    type === "proposal" ||
    type === "tool_result" ||
    type === "validation" ||
    type === "error"
  );
}
