import { randomUUID } from "node:crypto";
import { resolveWorkshopModel } from "../workshop/modelSettings.js";
import {
  createAuthorSession,
  readAuthorSession,
  saveAuthorSession,
  type AuthorSessionRecord,
} from "./authorSessionStore.js";
import { describeChanges, type SummaryLine } from "./definitionSummary.js";
import {
  AGENT_AUTHOR_PROFILE_ID,
  createAgentAuthorContext,
  isAgentAuthorContext,
  readAgentAuthorDraft,
  type AgentAuthorDraft,
  type OperatorAgentHost,
  type OperatorAgentSession,
} from "../operatorAgent/index.js";

export type AgentAuthorTurnResult = {
  sessionId: string;
  text: string;
  draft: AgentAuthorDraft;
  /** One line per config section this turn changed. Empty when the turn only talked. */
  summaryLines: SummaryLine[];
};

const sessions = new Map<string, OperatorAgentSession>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameDraftValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Objects walk key by key; arrays and scalars are wholes. Turn changes win, including removals. */
function mergeTurnDraft(start: AgentAuthorDraft, end: AgentAuthorDraft, disk: AgentAuthorDraft): AgentAuthorDraft {
  const keys = new Set([...Object.keys(start), ...Object.keys(end), ...Object.keys(disk)]);
  const next: AgentAuthorDraft = {};
  for (const key of keys) {
    const startHas = Object.prototype.hasOwnProperty.call(start, key);
    const endHas = Object.prototype.hasOwnProperty.call(end, key);
    const diskHas = Object.prototype.hasOwnProperty.call(disk, key);
    if (startHas && !endHas) continue;
    if (!endHas) {
      if (diskHas) next[key] = structuredClone(disk[key]);
      continue;
    }
    if (!startHas) {
      next[key] = structuredClone(end[key]);
      continue;
    }
    const startVal = start[key];
    const endVal = end[key];
    const diskVal = disk[key];
    if (isPlainObject(startVal) && isPlainObject(endVal) && (!diskHas || isPlainObject(diskVal))) {
      if (!diskHas && sameDraftValue(startVal, endVal)) continue;
      next[key] = mergeTurnDraft(startVal, endVal, diskHas && isPlainObject(diskVal) ? diskVal : {});
      continue;
    }
    if (sameDraftValue(startVal, endVal)) {
      if (diskHas) next[key] = structuredClone(diskVal);
    } else {
      next[key] = structuredClone(endVal);
    }
  }
  return next;
}

export function resetAgentAuthorSessionsForTests(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

export function forgetAgentAuthorSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.close();
  sessions.delete(sessionId);
}

export async function runAgentAuthorTurn(input: {
  host: OperatorAgentHost;
  projectRoot: string;
  message: string;
  sessionId?: string;
  draft?: AgentAuthorDraft;
  /** Composer override. Blank uses the same default as Workshop chat. */
  model?: string | null;
}): Promise<AgentAuthorTurnResult> {
  const message = input.message.trim();
  if (!message) throw new Error("agent.invalid");
  let sessionId = input.sessionId?.trim();
  let record = sessionId ? readAuthorSession(sessionId) : null;
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session && !record) throw new Error("agent.session_not_found");
  const posted = createAgentAuthorContext({
    projectRoot: input.projectRoot,
    draft: input.draft ?? record?.draft,
  });
  if (!record) {
    const draft = readAgentAuthorDraft(posted);
    if (!sessionId) {
      record = createAuthorSession({ draft, model: input.model ?? undefined });
      sessionId = record.id;
    } else {
      const now = new Date().toISOString();
      record = saveAuthorSession({
        version: 1,
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        draft,
        transcript: [],
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      });
    }
  }
  if (!sessionId || !record) throw new Error("agent.invalid");
  if (!session) {
    session = input.host.openSession({
      profileId: AGENT_AUTHOR_PROFILE_ID,
      context: posted,
    });
    sessions.set(sessionId, session);
    if (record.transcript.length > 0) {
      await session.prepareRestart?.(
        record.transcript.map((entry) => ({ role: entry.role, text: entry.text })),
      );
    }
  }
  session.setContext(posted);
  const before = readAgentAuthorDraft(session.getContext());
  const modelId = resolveWorkshopModel({ sessionOverride: input.model ?? record.model });
  const events = await session.send(message, { modelId });
  const text = events
    .filter((event) => event.type === "message" && event.role === "assistant")
    .map((event) => (event.type === "message" ? event.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const error = events.find((event) => event.type === "error");
  const draft = readAgentAuthorDraft(session.getContext());
  const summaryLines = describeChanges(before, draft);
  const latest = readAuthorSession(sessionId);
  if (!latest) throw new Error("agent.session_not_found");
  const merged = mergeTurnDraft(before, draft, latest.draft);
  const now = new Date().toISOString();
  const saved = saveAuthorSession({
    ...latest,
    draft: merged,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    transcript: [
      ...latest.transcript,
      { id: randomUUID(), role: "user", text: message, createdAt: now },
      {
        id: randomUUID(),
        role: "assistant",
        text: text || (error && error.type === "error" ? error.message : ""),
        createdAt: now,
        ...(summaryLines.length > 0 ? { summaryLines } : {}),
      },
    ],
  });
  return {
    sessionId: saved.id,
    text: saved.transcript.at(-1)?.text ?? "",
    draft: merged,
    summaryLines,
  };
}

export function undoAgentAuthorTurn(sessionId: string): AgentAuthorDraft {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("agent.session_not_found");
  const undone = session.undoMutation();
  if (!undone.ok) throw new Error(undone.reason === "conflict" ? "agent.conflict" : "agent.invalid");
  const context = session.getContext();
  if (!isAgentAuthorContext(context)) throw new Error("agent.invalid");
  const draft = readAgentAuthorDraft(context);
  const record = readAuthorSession(sessionId);
  if (record) saveAuthorSession({ ...record, draft });
  return draft;
}

export function authorSessionForApi(sessionId: string): AuthorSessionRecord {
  const record = readAuthorSession(sessionId);
  if (!record) throw new Error("agent.session_not_found");
  return record;
}

export function parseAgentAuthorDraft(body: unknown): AgentAuthorDraft {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as AgentAuthorDraft) : {};
}
