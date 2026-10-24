import { isAgentError } from "../agents/errors.js";
import type { AgentSessionDetail } from "../agents/service.js";
import type { AgentSessionListItem, SessionQuery } from "../agents/store.js";
import type { NewDatasetCase } from "./writeDataset.js";

/** The slice of `AgentService` that turns past sessions into scenarios. */
export type SessionsSource = {
  listSessions(
    projectRoot: string,
    agentId: string,
    query: SessionQuery,
  ): Promise<{ sessions: AgentSessionListItem[]; nextCursor: string | null }>;
  getSession(projectRoot: string, sessionId: string): Promise<AgentSessionDetail>;
};

export type SessionCandidate = {
  session_id: string;
  updated_at: string;
  preview: string;
  turns: number;
  tools: string[];
};

export class SessionCaseError extends Error {}

const PREVIEW_CHARS = 160;
const SCRIPT_MAX_MESSAGES = 40;
const SCRIPT_MAX_CHARS = 4000;
const SESSION_TAG = "from-session";

function userMessages(detail: AgentSessionDetail): string[] {
  return detail.messages
    .filter((m) => m.role === "user" && m.text.trim() !== "")
    .map((m) => m.text.slice(0, SCRIPT_MAX_CHARS))
    .slice(0, SCRIPT_MAX_MESSAGES);
}

function toolNames(detail: AgentSessionDetail): string[] {
  const names = new Set<string>();
  for (const span of detail.spans) {
    if (span.kind !== "tool") continue;
    const name = span.attributes["gen_ai.tool.name"];
    if (typeof name === "string" && name !== "") names.add(name);
  }
  return [...names];
}

function shortId(sessionId: string): string {
  return sessionId.replace(/^ses_/, "").slice(0, 8);
}

function isFinishedStatus(status: string): boolean {
  return status === "open" || status === "closed";
}

function isFinishedUserSession(detail: AgentSessionDetail, agentId: string): boolean {
  const { session } = detail;
  return session.agentId === agentId && session.source !== "eval" && isFinishedStatus(session.status);
}

/** Finished (idle or closed), non-eval sessions of the agent that have at least one user message, newest first. */
export async function listSessionCandidates(input: {
  sessions: SessionsSource;
  projectRoot: string;
  agentId: string;
  limit: number;
}): Promise<SessionCandidate[]> {
  const { sessions, projectRoot, agentId, limit } = input;
  const items: SessionCandidate[] = [];
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await sessions.listSessions(projectRoot, agentId, {
        limit: Math.max(limit, 25),
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch (err) {
      if (isAgentError(err)) throw new SessionCaseError(`Agent "${agentId}" was not found`);
      throw err;
    }
    for (const row of page.sessions) {
      if (row.source === "eval" || !isFinishedStatus(row.status)) continue;
      if (row.lastTurnStatus === "running" || row.lastTurnStatus === "waiting") continue;
      const detail = await sessions.getSession(projectRoot, row.id);
      const messages = userMessages(detail);
      if (messages.length === 0) continue;
      items.push({
        session_id: row.id,
        updated_at: row.updatedAt,
        preview: messages[0]!.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS),
        turns: messages.length,
        tools: toolNames(detail),
      });
      if (items.length >= limit) return items;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

/** One `script` scenario per session: its user messages, plus the tools it called as the expected tools. */
export async function casesFromSessions(input: {
  sessions: SessionsSource;
  projectRoot: string;
  agentId: string;
  sessionIds: readonly string[];
}): Promise<NewDatasetCase[]> {
  const { sessions, projectRoot, agentId } = input;
  const cases: NewDatasetCase[] = [];
  for (const sessionId of input.sessionIds) {
    let detail: AgentSessionDetail;
    try {
      detail = await sessions.getSession(projectRoot, sessionId);
    } catch (err) {
      if (isAgentError(err)) throw new SessionCaseError(`Session "${sessionId}" was not found`);
      throw err;
    }
    if (!isFinishedUserSession(detail, agentId)) {
      throw new SessionCaseError(`Session "${sessionId}" is not a finished session of agent "${agentId}"`);
    }
    const script = userMessages(detail);
    if (script.length === 0) throw new SessionCaseError(`Session "${sessionId}" has no user messages`);
    cases.push({
      title: detail.session.title ?? `Session ${shortId(sessionId)}`,
      input: { mode: "script", script, opening: script[0] },
      expected: { tools: toolNames(detail) },
      tags: [SESSION_TAG],
      metadata: { source_session: sessionId },
    });
  }
  return cases;
}
