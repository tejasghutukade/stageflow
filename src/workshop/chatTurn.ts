import type { DraftPackage } from "../config/draftPackage.js";
import {
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  readDraftFromContext,
  WORKSHOP_AUTHOR_PROFILE_ID,
  type OperatorAgentHost,
  type OperatorAgentProposal,
  type OperatorAgentSessionEvent,
  type ProposalArtifactDiff,
} from "../operatorAgent/index.js";
import { resolveWorkshopModel } from "./modelSettings.js";

export type WorkshopChatProposalPayload = {
  id: string;
  summary: string;
  nextDraft: DraftPackage;
  baseDraft: DraftPackage;
  baseFingerprint: string;
  artifacts: ProposalArtifactDiff[];
  affectedStageIds: string[];
};

export type WorkshopChatWireEvent =
  | { type: "message"; role: "assistant" | "user" | "system"; text: string }
  | {
      type: "proposal";
      proposal: WorkshopChatProposalPayload;
    }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "validation"; result: unknown }
  | { type: "error"; message: string };

export type WorkshopChatTurnInput = {
  draft: DraftPackage;
  message: string;
  /** @deprecated Ignored — mutations apply immediately (Accept = soft undo). */
  autoApply?: boolean;
  /** Session model override from Workshop chrome. */
  model?: string | null;
  /** Settings default from factory settings /api/settings. */
  settingsDefault?: string | null;
  /** Injected host (tests / fake). Defaults to Workshop fake Author host. */
  host?: OperatorAgentHost;
};

export type WorkshopChatTurnResult = {
  events: WorkshopChatWireEvent[];
  draft: DraftPackage;
  /** Latest undoable mutation card, or null after Accept/undo. */
  pending: WorkshopChatProposalPayload | null;
  /** Always false — auto-apply removed; mutations apply immediately. */
  autoApply: boolean;
  model: string;
};

export type WorkshopChatStreamFrame =
  | { type: "delta"; text: string }
  | { type: "event"; event: WorkshopChatWireEvent }
  | {
      type: "done";
      events: WorkshopChatWireEvent[];
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
      autoApply: boolean;
      model: string;
    };

function isDraftPackage(value: unknown): value is DraftPackage {
  return (
    value !== null &&
    typeof value === "object" &&
    "pipeline" in value &&
    typeof (value as DraftPackage).pipeline === "object" &&
    (value as DraftPackage).pipeline !== null
  );
}

function draftFromContextValue(
  value: unknown,
  fallback: DraftPackage,
): DraftPackage {
  if (isDraftPackage(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "draft" in value &&
    isDraftPackage((value as { draft: unknown }).draft)
  ) {
    return (value as { draft: DraftPackage }).draft;
  }
  return fallback;
}

export function serializeWorkshopProposal(
  proposal: OperatorAgentProposal,
  fallbackDraft: DraftPackage,
): WorkshopChatProposalPayload {
  const nextDraft = draftFromContextValue(proposal.nextContext, fallbackDraft);
  const baseDraft = draftFromContextValue(
    proposal.baseContext,
    fallbackDraft,
  );
  return {
    id: proposal.id,
    summary: proposal.summary,
    nextDraft,
    baseDraft,
    baseFingerprint:
      typeof proposal.baseFingerprint === "string" && proposal.baseFingerprint
        ? proposal.baseFingerprint
        : JSON.stringify(baseDraft),
    artifacts: Array.isArray(proposal.artifacts) ? proposal.artifacts : [],
    affectedStageIds: Array.isArray(proposal.affectedStageIds)
      ? proposal.affectedStageIds
      : [],
  };
}

export function toWorkshopChatWireEvent(
  event: OperatorAgentSessionEvent,
  fallbackDraft: DraftPackage,
): WorkshopChatWireEvent {
  if (event.type === "proposal") {
    return {
      type: "proposal",
      proposal: serializeWorkshopProposal(event.proposal, fallbackDraft),
    };
  }
  if (event.type === "message") {
    return {
      type: "message",
      role: event.role,
      text: event.text,
    };
  }
  if (event.type === "tool_result") {
    return {
      type: "tool_result",
      name: event.name,
      result: event.result,
    };
  }
  if (event.type === "validation") {
    return { type: "validation", result: event.result };
  }
  return { type: "error", message: event.message };
}

/**
 * One Workshop Author turn on the Operator Agent Host (not AgentPort).
 * Stateless: opens a session, sends, returns wire events + draft snapshot.
 * Mutations apply immediately; `pending` is the undo receipt for Accept/Reject.
 */
export async function runWorkshopChatTurn(
  input: WorkshopChatTurnInput,
): Promise<WorkshopChatTurnResult> {
  const message = input.message.trim();
  if (!message) {
    throw new Error("message is required");
  }

  const model = resolveWorkshopModel({
    sessionOverride: input.model,
    settingsDefault: input.settingsDefault,
  });

  const host = input.host ?? createWorkshopOperatorHost();
  const session = host.openSession({
    profileId: WORKSHOP_AUTHOR_PROFILE_ID,
    context: createWorkshopDraftContext(input.draft),
  });

  try {
    const rawEvents = await session.send(message);
    const draft = readDraftFromContext(session.getContext());
    const pendingRaw = session.getPendingProposal();
    const events = rawEvents.map((event) =>
      toWorkshopChatWireEvent(event, input.draft),
    );
    return {
      events,
      draft,
      pending: pendingRaw
        ? serializeWorkshopProposal(pendingRaw, input.draft)
        : null,
      autoApply: false,
      model,
    };
  } finally {
    session.close();
  }
}

/** Chunk assistant text for NDJSON stream frames (fake/live coherent turns). */
export function chunkAssistantText(
  text: string,
  chunkSize = 28,
): string[] {
  if (!text) return [];
  const size = Math.max(1, chunkSize);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export function* iterateWorkshopChatStreamFrames(
  result: WorkshopChatTurnResult,
): Generator<WorkshopChatStreamFrame> {
  for (const event of result.events) {
    if (event.type === "message" && event.role === "assistant") {
      for (const text of chunkAssistantText(event.text)) {
        yield { type: "delta", text };
      }
    }
    yield { type: "event", event };
  }
  yield {
    type: "done",
    events: result.events,
    draft: result.draft,
    pending: result.pending,
    autoApply: result.autoApply,
    model: result.model,
  };
}
