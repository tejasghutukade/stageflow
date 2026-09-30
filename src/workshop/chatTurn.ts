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

/**
 * Accept-card / soft-undo payload for a mutation that is **already applied**
 * to the in-memory draft. `nextDraft` is current; `baseDraft` + fingerprint
 * are the undo restore target when Reject is safe. Not a gated propose→Accept
 * patch — create/edit tools mutate immediately.
 */
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
  /** Mutation receipt for Accept/Reject UX (draft already mutated). */
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
  /**
   * Mid-turn assistant text callback. Invoked as model deltas arrive (before
   * the turn promise resolves). HTTP uses this to flush NDJSON `delta` frames.
   */
  onDelta?: (text: string) => void;
};

export type WorkshopChatTurnResult = {
  sessionId: string;
  events: WorkshopChatWireEvent[];
  /** Client-posted draft after this turn's mutations (already applied). */
  draft: DraftPackage;
  /**
   * Latest undoable mutation card (already applied), or null after
   * Accept/undo. Name is historical — not a pending gated apply.
   */
  pending: WorkshopChatProposalPayload | null;
  /** Always false — auto-apply chrome removed; mutations apply immediately. */
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
const TURN_IN_FLIGHT_UNDO_NOTICE =
  "Cannot undo while a chat turn is in progress.";

export class WorkshopChatSessionRegistry {
  private readonly sessions = new Map<string, WorkshopLiveSessionHandle>();
  private readonly turnsInFlight = new Set<string>();

  constructor(readonly host: OperatorAgentHost) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): OperatorAgentSession | undefined {
    return this.sessions.get(sessionId)?.agentSession;
  }

  isTurnInFlight(sessionId: string): boolean {
    return this.turnsInFlight.has(sessionId);
  }

  beginTurn(sessionId: string): void {
    this.turnsInFlight.add(sessionId);
  }

  endTurn(sessionId: string): void {
    this.turnsInFlight.delete(sessionId);
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
    this.turnsInFlight.delete(sessionId);
  }

  clear(): void {
    for (const handle of this.sessions.values()) {
      handle.agentSession.close();
    }
    this.sessions.clear();
    this.turnsInFlight.clear();
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
  // Wire shape for Accept/Reject cards — mutation already applied on the host.
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
  registry.beginTurn(sessionId);
  let rawEvents: OperatorAgentSessionEvent[];
  try {
    rawEvents = await agentSession.send(message, {
      onDelta: input.onDelta,
    });
  } finally {
    registry.endTurn(sessionId);
  }
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
  options?: { chunkAssistantText?: boolean },
): Generator<WorkshopChatStreamFrame> {
  const chunkText = options?.chunkAssistantText !== false;
  for (const event of result.events) {
    if (
      chunkText &&
      event.type === "message" &&
      event.role === "assistant"
    ) {
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

export type WorkshopSessionUndoInput = {
  sessionId: string;
  draft: DraftPackage;
  mutationId?: string;
  host?: OperatorAgentHost;
  registry?: WorkshopChatSessionRegistry;
  storeRoot?: string;
};

export type WorkshopSessionUndoResult =
  | {
      ok: true;
      sessionId: string;
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
    }
  | {
      ok: false;
      sessionId: string;
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
      reason: "none" | "id_mismatch" | "conflict";
      notice?: string;
    };

export type WorkshopSessionAcceptInput = {
  sessionId: string;
  draft: DraftPackage;
  mutationId?: string;
  host?: OperatorAgentHost;
  registry?: WorkshopChatSessionRegistry;
  storeRoot?: string;
};

export type WorkshopSessionAcceptResult =
  | {
      ok: true;
      sessionId: string;
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
    }
  | {
      ok: false;
      sessionId: string;
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
      reason: "none" | "id_mismatch" | "conflict";
      notice?: string;
    };

function snapshotLiveSession(
  registry: WorkshopChatSessionRegistry,
  sessionId: string,
  fallbackDraft: DraftPackage,
): {
  draft: DraftPackage;
  pending: WorkshopChatProposalPayload | null;
} {
  const session = registry.get(sessionId);
  if (!session) {
    return { draft: fallbackDraft, pending: null };
  }
  const draft = readDraftFromContext(session.getContext());
  const pendingRaw = session.getPendingProposal();
  return {
    draft,
    pending: pendingRaw
      ? serializeWorkshopProposal(pendingRaw, draft)
      : null,
  };
}

/**
 * Soft-undo a mutation on a durable Workshop host session.
 * Rebinds the client draft first (R9), then undoes when fingerprint matches.
 * Fail-closed during an in-flight chat turn: no rebind, conflict.
 */
export async function undoWorkshopSessionMutation(
  input: WorkshopSessionUndoInput,
): Promise<WorkshopSessionUndoResult> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const storeRoot = input.storeRoot ?? resolveWorkshopSessionStoreRoot();
  getWorkshopSession(storeRoot, sessionId);

  const registry = input.registry ?? getDefaultRegistry(input.host);
  if (input.host && registry.host !== input.host) {
    throw new Error("host does not match workshop chat session registry");
  }

  if (registry.isTurnInFlight(sessionId)) {
    const snap = snapshotLiveSession(registry, sessionId, input.draft);
    return {
      ok: false,
      sessionId,
      draft: snap.draft,
      pending: snap.pending,
      reason: "conflict",
      notice: TURN_IN_FLIGHT_UNDO_NOTICE,
    };
  }

  const { session } = registry.getOrOpen(sessionId, input.draft);
  const undo = session.undoMutation(input.mutationId);
  const draft = readDraftFromContext(session.getContext());
  const pendingRaw = session.getPendingProposal();
  const pending = pendingRaw
    ? serializeWorkshopProposal(pendingRaw, draft)
    : null;

  if (undo.ok) {
    return { ok: true, sessionId, draft, pending };
  }
  return {
    ok: false,
    sessionId,
    draft,
    pending,
    reason: undo.reason,
    ...(undo.notice !== undefined ? { notice: undo.notice } : {}),
  };
}

/** Accept acknowledges a mutation card; draft is already applied. */
export async function acceptWorkshopSessionMutation(
  input: WorkshopSessionAcceptInput,
): Promise<WorkshopSessionAcceptResult> {
  const sessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const storeRoot = input.storeRoot ?? resolveWorkshopSessionStoreRoot();
  getWorkshopSession(storeRoot, sessionId);

  const registry = input.registry ?? getDefaultRegistry(input.host);
  if (input.host && registry.host !== input.host) {
    throw new Error("host does not match workshop chat session registry");
  }

  if (registry.isTurnInFlight(sessionId)) {
    const snap = snapshotLiveSession(registry, sessionId, input.draft);
    return {
      ok: false,
      sessionId,
      draft: snap.draft,
      pending: snap.pending,
      reason: "conflict",
      notice: TURN_IN_FLIGHT_UNDO_NOTICE,
    };
  }

  const { session } = registry.getOrOpen(sessionId, input.draft);
  const accepted = session.acceptProposal(input.mutationId);
  const draft = readDraftFromContext(session.getContext());
  const pendingRaw = session.getPendingProposal();
  const pending = pendingRaw
    ? serializeWorkshopProposal(pendingRaw, draft)
    : null;

  if (accepted.ok) {
    return { ok: true, sessionId, draft, pending };
  }
  return {
    ok: false,
    sessionId,
    draft,
    pending,
    reason: accepted.reason,
    ...(accepted.notice !== undefined ? { notice: accepted.notice } : {}),
  };
}

export { WorkshopSessionStoreError };
