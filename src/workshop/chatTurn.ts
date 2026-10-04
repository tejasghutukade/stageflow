import path from "node:path";
import type { DraftPackage } from "../config/draftPackage.js";
import {
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  isWorkshopDraftContext,
  readDraftFromContext,
  withDraft,
  WORKSHOP_AUTHOR_PROFILE_ID,
  type OperatorAgentHost,
  type OperatorAgentProposal,
  type OperatorAgentSession,
  type OperatorAgentSessionEvent,
  type OperatorAgentToolResult,
  type ProposalArtifactDiff,
  type WorkshopDraftContext,
  type WorkshopToolActivityUpdate,
} from "../operatorAgent/index.js";
import { resolveWorkshopModel } from "./modelSettings.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  readWorkshopBuild,
  updateWorkshopBuild,
  type WorkshopBuildRecord,
} from "./buildStore.js";
import {
  appendWorkshopSessionMessages,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  updateWorkshopSessionActiveBuildId,
  WorkshopSessionStoreError,
  type WorkshopSessionAppendMessage,
} from "./sessionStore.js";

export const WORKSHOP_UNLINKED_DRAFT_TOOL_ERROR =
  "No build is selected — draft tools cannot edit or save until a build is focused.";

const WORKSHOP_DRAFT_TOOL_NAMES = new Set([
  "read_draft",
  "validate_draft",
  "create_pipeline",
  "edit_pipeline",
  "create_stage",
  "edit_stage",
  "create_task",
  "edit_task",
  "save",
  "propose_draft",
]);

export type WorkshopPointerChange = {
  buildId: string;
  draft: DraftPackage;
};

type LiveTurnBinding = {
  storeRoot: string;
  onPointerChange?: (frame: WorkshopPointerChange) => void;
};

const sessionWriteTails = new Map<string, Promise<void>>();
const liveBySession = new Map<
  string,
  { storeRoot: string; registry: WorkshopChatSessionRegistry }
>();

function enqueueSessionWrite<T>(sessionId: string, fn: () => T): Promise<T> {
  const prev = sessionWriteTails.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  sessionWriteTails.set(
    sessionId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function destinationFromRelativePath(relativePath: string): {
  directory: string;
  pipelineFilename: string;
} {
  const normalized = relativePath.replace(/\\/g, "/");
  const pipelineFilename = path.posix.basename(normalized);
  const dir = path.posix.dirname(normalized);
  return {
    directory: dir === "." ? "." : dir,
    pipelineFilename,
  };
}

function relativePathFromDestination(
  directory: string,
  pipelineFilename: string,
): string {
  const dir = directory.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const file = path.posix.basename(pipelineFilename.trim().replace(/\\/g, "/"));
  if (!dir || dir === ".") return file;
  return `${dir.replace(/\/+$/, "")}/${file}`;
}

function bindPinnedBuildContext(
  current: unknown,
  build: WorkshopBuildRecord,
  sessionId: string,
): WorkshopDraftContext {
  const base: WorkshopDraftContext = isWorkshopDraftContext(current)
    ? { ...current }
    : { draft: build.draft };
  const next: WorkshopDraftContext = {
    ...base,
    draft: build.draft,
    chatSessionId: sessionId,
    buildId: build.id,
  };
  if (build.projectRoot) next.projectRoot = build.projectRoot;
  else delete next.projectRoot;
  if (build.projectRoot && build.relativePath) {
    next.destination = destinationFromRelativePath(build.relativePath);
  } else {
    delete next.destination;
  }
  return next;
}

function markUnlinkedChatContext(
  current: unknown,
  sessionId: string,
  draft: DraftPackage,
): WorkshopDraftContext {
  const base: WorkshopDraftContext = isWorkshopDraftContext(current)
    ? { ...current, draft }
    : { draft };
  delete base.buildId;
  base.chatSessionId = sessionId;
  base.draft = draft;
  return base;
}

function emitPointerChange(
  registry: WorkshopChatSessionRegistry,
  sessionId: string,
  build: WorkshopBuildRecord,
): void {
  registry.getLiveTurn(sessionId)?.onPointerChange?.({
    buildId: build.id,
    draft: build.draft,
  });
}

function movePinOntoBuild(
  registry: WorkshopChatSessionRegistry,
  sessionId: string,
  build: WorkshopBuildRecord,
  storeRoot: string,
): void {
  const session = registry.get(sessionId);
  if (session) {
    session.setContext(
      bindPinnedBuildContext(session.getContext(), build, sessionId),
    );
  }
  registry.setPinnedBuildId(sessionId, build.id);
  enqueueSessionWrite(sessionId, () => {
    updateWorkshopSessionActiveBuildId(storeRoot, sessionId, build.id);
  });
  emitPointerChange(registry, sessionId, build);
}

export function resolveLiveWorkshopBinding(context: unknown): {
  sessionId: string;
  registry: WorkshopChatSessionRegistry;
  storeRoot: string;
} | null {
  if (!isWorkshopDraftContext(context) || !context.chatSessionId) return null;
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return null;
  return {
    sessionId: context.chatSessionId,
    registry: live.registry,
    storeRoot: live.storeRoot,
  };
}

/**
 * Draft tools call this. Outside a workshop chat turn it does nothing.
 * An unlinked chat turn fails the tool and does not create a build.
 */
export function rejectUnlinkedWorkshopDraftTool(
  context: unknown,
  toolName: string,
): OperatorAgentToolResult | null {
  if (!WORKSHOP_DRAFT_TOOL_NAMES.has(toolName)) return null;
  if (!isWorkshopDraftContext(context) || !context.chatSessionId) return null;
  if (context.buildId) return null;
  return {
    ok: false,
    content: null,
    error: WORKSHOP_UNLINKED_DRAFT_TOOL_ERROR,
  };
}

/** Tied builds save to the stored path. Untitled builds keep the caller's destination. */
export function resolvePinnedSaveDestination(
  context: unknown,
): { directory: string; pipelineFilename: string } | null {
  if (
    !isWorkshopDraftContext(context) ||
    !context.buildId ||
    !context.chatSessionId
  ) {
    return null;
  }
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return null;
  const build = readWorkshopBuild(live.storeRoot, context.buildId);
  if (!build?.projectRoot || !build.relativePath) return null;
  return destinationFromRelativePath(build.relativePath);
}

/** A successful save of an untitled build records the operator destination on that id. */
export function recordPinnedWorkshopSave(
  context: unknown,
  saved: {
    directory: string;
    pipelineFilename?: string;
    projectRoot: string;
    draft: DraftPackage;
  },
): void {
  if (
    !isWorkshopDraftContext(context) ||
    !context.buildId ||
    !context.chatSessionId
  ) {
    return;
  }
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return;
  const build = readWorkshopBuild(live.storeRoot, context.buildId);
  if (!build || (build.projectRoot && build.relativePath)) return;
  const pipelineFilename =
    saved.pipelineFilename?.trim() ||
    `${saved.draft.pipeline.id}.pipeline.yaml`;
  updateWorkshopBuild(live.storeRoot, build.id, {
    draft: saved.draft,
    projectRoot: path.resolve(saved.projectRoot),
    relativePath: relativePathFromDestination(
      saved.directory,
      pipelineFilename,
    ),
  });
}

/**
 * Create an untitled build and move this turn's pin onto it.
 * Later edits in the turn persist on that id.
 */
export function pinWorkshopBuildOnCreate(input: {
  sessionId: string;
  draft: DraftPackage;
  registry: WorkshopChatSessionRegistry;
  storeRoot: string;
}): WorkshopBuildRecord {
  const build = createWorkshopBuild(input.storeRoot, { draft: input.draft });
  liveBySession.set(input.sessionId, {
    storeRoot: input.storeRoot,
    registry: input.registry,
  });
  movePinOntoBuild(input.registry, input.sessionId, build, input.storeRoot);
  return build;
}

/**
 * Focus a build. When this turn already has a pin, update the pointer only.
 * When the turn started with none, move the pin and the host onto that build.
 */
export function focusWorkshopBuildPointer(input: {
  sessionId: string;
  buildId: string;
  registry: WorkshopChatSessionRegistry;
  storeRoot: string;
}): { pinMoved: boolean; activeBuildId: string } {
  const build = getWorkshopBuild(input.storeRoot, input.buildId);
  liveBySession.set(input.sessionId, {
    storeRoot: input.storeRoot,
    registry: input.registry,
  });
  const pinned = input.registry.getPinnedBuildId(input.sessionId);
  const turnLive = input.registry.getLiveTurn(input.sessionId);
  const pinMoved = Boolean(turnLive) && !pinned;
  if (pinMoved) {
    movePinOntoBuild(
      input.registry,
      input.sessionId,
      build,
      input.storeRoot,
    );
  } else {
    enqueueSessionWrite(input.sessionId, () => {
      updateWorkshopSessionActiveBuildId(
        input.storeRoot,
        input.sessionId,
        build.id,
      );
    });
    if (turnLive) emitPointerChange(input.registry, input.sessionId, build);
  }
  return { pinMoved, activeBuildId: build.id };
}

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
  /** Mid-turn tool status. HTTP flushes this as an NDJSON activity frame. */
  onActivity?: (update: WorkshopToolActivityUpdate) => void;
  /** Fired when this turn changes the session pointer. */
  onPointerChange?: (frame: WorkshopPointerChange) => void;
};

export type WorkshopChatTurnResult = {
  sessionId: string;
  events: WorkshopChatWireEvent[];
  /** Draft left on the host after this turn. Pinned turns use the build, not the posted body. */
  draft: DraftPackage;
  /**
   * Latest undoable mutation card (already applied), or null after
   * Accept/undo. Name is historical — not a pending gated apply.
   */
  pending: WorkshopChatProposalPayload | null;
  /** Always false — auto-apply chrome removed; mutations apply immediately. */
  autoApply: boolean;
  model: string;
  /** Build this turn edited. Null when the chat stayed unlinked. */
  buildId: string | null;
};

export type WorkshopChatStreamFrame =
  | { type: "delta"; text: string }
  | ({ type: "activity" } & WorkshopToolActivityUpdate)
  | { type: "pointer-change"; buildId: string; draft: DraftPackage }
  | { type: "event"; event: WorkshopChatWireEvent }
  | {
      type: "done";
      sessionId: string;
      events: WorkshopChatWireEvent[];
      draft: DraftPackage;
      pending: WorkshopChatProposalPayload | null;
      autoApply: boolean;
      model: string;
      buildId: string | null;
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
  private readonly turnChains = new Map<string, Promise<void>>();
  private readonly pins = new Map<string, string | null>();
  private readonly liveTurns = new Map<string, LiveTurnBinding>();

  constructor(readonly host: OperatorAgentHost) {}

  runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turnChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.turnChains.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  bindTurn(
    sessionId: string,
    binding: LiveTurnBinding,
    pinnedBuildId: string | null,
  ): void {
    this.liveTurns.set(sessionId, binding);
    this.pins.set(sessionId, pinnedBuildId);
    liveBySession.set(sessionId, {
      storeRoot: binding.storeRoot,
      registry: this,
    });
  }

  getLiveTurn(sessionId: string): LiveTurnBinding | undefined {
    return this.liveTurns.get(sessionId);
  }

  getPinnedBuildId(sessionId: string): string | null {
    return this.pins.get(sessionId) ?? null;
  }

  setPinnedBuildId(sessionId: string, buildId: string | null): void {
    this.pins.set(sessionId, buildId);
  }

  clearLive(sessionId: string): void {
    this.liveTurns.delete(sessionId);
    liveBySession.delete(sessionId);
  }

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
   * Interrupt the open host session's in-flight prompt.
   * Returns false when this session has no turn running.
   */
  async abortTurn(sessionId: string): Promise<boolean> {
    if (!this.turnsInFlight.has(sessionId)) return false;
    const session = this.sessions.get(sessionId)?.agentSession;
    if (!session) return false;
    await session.abort();
    return true;
  }

  /**
   * Reuse the open host session when present; otherwise open a new one.
   * Rebinds the draft argument. Pinned turns pass the stored build draft.
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
    this.turnChains.clear();
    this.pins.clear();
    this.liveTurns.clear();
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
  sessionWriteTails.clear();
  liveBySession.clear();
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
 * Does not close the host session after the turn.
 * A pinned build's stored draft is the source of truth. An unlinked turn
 * still binds the client draft, and draft tools fail until a build is pinned.
 * A second turn for the same session waits until this one finishes.
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
  const model = resolveWorkshopModel({
    sessionOverride: input.model,
    settingsDefault: input.settingsDefault,
  });

  const registry =
    input.registry ?? getDefaultRegistry(input.host);
  if (input.host && registry.host !== input.host) {
    throw new Error("host does not match workshop chat session registry");
  }

  return registry.runExclusive(sessionId, async () => {
    // Fail closed: chat never creates missing sessions (prefer New → create).
    const storeRecord = getWorkshopSession(storeRoot, sessionId);
    const pinnedBuild = storeRecord.activeBuildId
      ? getWorkshopBuild(storeRoot, storeRecord.activeBuildId)
      : null;
    const draftForOpen = pinnedBuild?.draft ?? input.draft;
    const { session: agentSession, created } = registry.getOrOpen(
      sessionId,
      draftForOpen,
    );
    if (pinnedBuild) {
      agentSession.setContext(
        bindPinnedBuildContext(agentSession.getContext(), pinnedBuild, sessionId),
      );
    } else {
      agentSession.setContext(
        markUnlinkedChatContext(
          agentSession.getContext(),
          sessionId,
          draftForOpen,
        ),
      );
    }
    registry.bindTurn(
      sessionId,
      {
        storeRoot,
        onPointerChange: input.onPointerChange,
      },
      pinnedBuild?.id ?? null,
    );

    registry.beginTurn(sessionId);
    let rawEvents: OperatorAgentSessionEvent[];
    let resultBuildId: string | null = null;
    try {
      // KTD7: process restart → new host session; replay disk transcript into Pi.
      if (
        created &&
        storeRecord.transcript.length > 0 &&
        typeof agentSession.prepareRestart === "function"
      ) {
        await agentSession.prepareRestart(storeRecord.transcript);
      }
      rawEvents = await agentSession.send(message, {
        onDelta: input.onDelta,
        onActivity: (update) => {
          const buildId = registry.getPinnedBuildId(sessionId);
          input.onActivity?.({
            ...update,
            ...(buildId ? { buildId } : {}),
          });
        },
        modelId: model,
      });
    } finally {
      try {
        resultBuildId = registry.getPinnedBuildId(sessionId);
        if (resultBuildId) {
          updateWorkshopBuild(storeRoot, resultBuildId, {
            draft: readDraftFromContext(agentSession.getContext()),
          });
        }
      } finally {
        registry.endTurn(sessionId);
        registry.clearLive(sessionId);
      }
    }
    const draft = readDraftFromContext(agentSession.getContext());
    const pendingRaw = agentSession.getPendingProposal();
    const events = rawEvents.map((event) =>
      toWorkshopChatWireEvent(event, draft),
    );

    await enqueueSessionWrite(sessionId, () => {
      appendWorkshopSessionMessages(
        storeRoot,
        sessionId,
        transcriptMessagesForTurn(message, events),
      );
    });

    return {
      sessionId,
      events,
      draft,
      pending: pendingRaw
        ? serializeWorkshopProposal(pendingRaw, draft)
        : null,
      autoApply: false,
      model,
      buildId: resultBuildId,
    };
  });
}

/** Stop the in-flight Author prompt and return the draft it left behind. */
export async function stopWorkshopChatTurn(
  registry: WorkshopChatSessionRegistry,
  sessionId: string,
): Promise<{
  stopped: boolean;
  draft: DraftPackage | null;
  pending: WorkshopChatProposalPayload | null;
  buildId: string | null;
}> {
  const stopped = await registry.abortTurn(sessionId);
  const buildId = registry.getPinnedBuildId(sessionId);
  const session = registry.get(sessionId);
  if (!session) {
    return { stopped, draft: null, pending: null, buildId };
  }
  const draft = readDraftFromContext(session.getContext());
  const pendingRaw = session.getPendingProposal();
  return {
    stopped,
    draft,
    pending: pendingRaw
      ? serializeWorkshopProposal(pendingRaw, draft)
      : null,
    buildId,
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
    buildId: result.buildId,
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
