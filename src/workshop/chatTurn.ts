import type { DraftPackage } from "../config/draftPackage.js";
import {
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  readDraftFromContext,
  withDraft,
  WORKSHOP_AUTHOR_PROFILE_ID,
  type OperatorAgentHost,
  type OperatorAgentProposal,
  type OperatorAgentSession,
  type OperatorAgentSessionEvent,
  type ProposalArtifactDiff,
} from "../operatorAgent/index.js";
import { resolveWorkshopModel } from "./modelSettings.js";
import {
  appendWorkshopSessionMessages,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  WorkshopSessionStoreError,
  type WorkshopSessionAppendMessage,
} from "./sessionStore.js";

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

/**
 * Chat requires an existing Workshop session id (created via New /
 * POST /api/workshop/sessions). Unknown ids return workshop_session_not_found
 * — no create-on-missing.
 */
export type WorkshopChatTurnInput = {
  sessionId: string;
  draft: DraftPackage;
  message: string;
  /** @deprecated Ignored — mutations apply immediately (Accept = soft undo). */
  autoApply?: boolean;
  /** Session model override from Workshop chrome. */
  model?: string | null;
  /** Settings default from factory settings /api/settings. */
  settingsDefault?: string | null;
  /**
   * Injected host (tests / fake). When omitted, uses the registry's host
   * (or a process-default Workshop fake Author host).
   */
  host?: OperatorAgentHost;
  /** Live host-session map; defaults to the process registry. */
  registry?: WorkshopChatSessionRegistry;
  /** Session store root; defaults to `$STAGEFLOW_HOME`. */
  storeRoot?: string;
};

export type WorkshopChatTurnResult = {
  sessionId: string;
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
      sessionId: string;
      events: WorkshopChatWireEvent[];
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
      autoApply: boolean;
      model: string;
    };

export type WorkshopLiveSessionHandle = {
  sessionId: string;
  agentSession: OperatorAgentSession;
};

/**
 * In-memory map of Workshop session id → open OperatorAgentSession.
 * Survives across chat turns until process restart (disk transcript remains).
 */
export class WorkshopChatSessionRegistry {
  private readonly sessions = new Map<string, WorkshopLiveSessionHandle>();

  constructor(readonly host: OperatorAgentHost) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): OperatorAgentSession | undefined {
    return this.sessions.get(sessionId)?.agentSession;
  }

  /**
   * Reuse the open host session when present; otherwise open a new one and
   * bind the client-posted draft. Always rebinds draft on each call (R9).
   * Returns whether this call created a new host session (restart / first open).
   */
  getOrOpen(
    sessionId: string,
    draft: DraftPackage,
  ): { session: OperatorAgentSession; created: boolean } {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.agentSession.setContext(
        withDraft(existing.agentSession.getContext(), draft),
      );
      return { session: existing.agentSession, created: false };
    }
    const agentSession = this.host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(draft),
    });
    this.sessions.set(sessionId, { sessionId, agentSession });
    return { session: agentSession, created: true };
  }

  close(sessionId: string): void {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    handle.agentSession.close();
    this.sessions.delete(sessionId);
  }

  clear(): void {
    for (const handle of this.sessions.values()) {
      handle.agentSession.close();
    }
    this.sessions.clear();
  }
}

let defaultHost: OperatorAgentHost | undefined;
let defaultRegistry: WorkshopChatSessionRegistry | undefined;

function getDefaultRegistry(host?: OperatorAgentHost): WorkshopChatSessionRegistry {
  if (host) {
    if (!defaultRegistry || defaultRegistry.host !== host) {
      defaultRegistry?.clear();
      defaultRegistry = new WorkshopChatSessionRegistry(host);
    }
    return defaultRegistry;
  }
  if (!defaultHost) {
    defaultHost = createWorkshopOperatorHost();
  }
  if (!defaultRegistry || defaultRegistry.host !== defaultHost) {
    defaultRegistry?.clear();
    defaultRegistry = new WorkshopChatSessionRegistry(defaultHost);
  }
  return defaultRegistry;
}

/** Test helper — drop process-default live sessions between cases. */
export function resetWorkshopChatSessionsForTests(): void {
  defaultRegistry?.clear();
  defaultRegistry = undefined;
  defaultHost = undefined;
}

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

function transcriptMessagesForTurn(
  userMessage: string,
  events: WorkshopChatWireEvent[],
): WorkshopSessionAppendMessage[] {
  const messages: WorkshopSessionAppendMessage[] = [
    { role: "user", text: userMessage },
  ];
  for (const event of events) {
    if (event.type === "message") {
      messages.push({ role: event.role, text: event.text });
    }
  }
  return messages;
}

/**
 * One Workshop Author turn on a durable Operator Agent Host session.
 * Requires an existing session store record (New / POST sessions first).
 * Does not close the host session after the turn (R7 / KTD4).
 * Client draft is rebound each turn (R9); transcript is appended to disk.
 */
export async function runWorkshopChatTurn(
  input: WorkshopChatTurnInput,
): Promise<WorkshopChatTurnResult> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const message = input.message.trim();
  if (!message) {
    throw new Error("message is required");
  }

  const storeRoot = input.storeRoot ?? resolveWorkshopSessionStoreRoot();
  // Fail closed: chat never creates missing sessions (prefer New → create).
  const storeRecord = getWorkshopSession(storeRoot, sessionId);

  const model = resolveWorkshopModel({
    sessionOverride: input.model,
    settingsDefault: input.settingsDefault,
  });

  const registry =
    input.registry ?? getDefaultRegistry(input.host);
  if (input.host && registry.host !== input.host) {
    throw new Error("host does not match workshop chat session registry");
  }

  const { session: agentSession, created } = registry.getOrOpen(
    sessionId,
    input.draft,
  );
  // KTD7: process restart → new host session; replay disk transcript into Pi.
  if (
    created &&
    storeRecord.transcript.length > 0 &&
    typeof agentSession.prepareRestart === "function"
  ) {
    await agentSession.prepareRestart(storeRecord.transcript);
  }
  const rawEvents = await agentSession.send(message);
  const draft = readDraftFromContext(agentSession.getContext());
  const pendingRaw = agentSession.getPendingProposal();
  const events = rawEvents.map((event) =>
    toWorkshopChatWireEvent(event, input.draft),
  );

  appendWorkshopSessionMessages(
    storeRoot,
    sessionId,
    transcriptMessagesForTurn(message, events),
  );

  return {
    sessionId,
    events,
    draft,
    pending: pendingRaw
      ? serializeWorkshopProposal(pendingRaw, input.draft)
      : null,
    autoApply: false,
    model,
  };
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
    sessionId: result.sessionId,
    events: result.events,
    draft: result.draft,
    pending: result.pending,
    autoApply: result.autoApply,
    model: result.model,
  };
}

export { WorkshopSessionStoreError };
