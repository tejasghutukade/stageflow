import { randomUUID } from "node:crypto";
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

export function resetAgentAuthorSessionsForTests(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

export async function runAgentAuthorTurn(input: {
  host: OperatorAgentHost;
  projectRoot: string;
  message: string;
  sessionId?: string;
  draft?: AgentAuthorDraft;
}): Promise<AgentAuthorTurnResult> {
  const message = input.message.trim();
  if (!message) throw new Error("agent.invalid");
  let sessionId = input.sessionId?.trim();
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session) throw new Error("agent.session_not_found");
  const posted = createAgentAuthorContext({
    projectRoot: input.projectRoot,
    draft: input.draft,
  });
  if (!session) {
    sessionId = randomUUID();
    session = input.host.openSession({
      profileId: AGENT_AUTHOR_PROFILE_ID,
      context: posted,
    });
    sessions.set(sessionId, session);
  } else {
    session.setContext(posted);
  }
  const before = readAgentAuthorDraft(session.getContext());
  const events = await session.send(message);
  const text = events
    .filter((event) => event.type === "message" && event.role === "assistant")
    .map((event) => (event.type === "message" ? event.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const error = events.find((event) => event.type === "error");
  const draft = readAgentAuthorDraft(session.getContext());
  return {
    sessionId: sessionId!,
    text: text || (error && error.type === "error" ? error.message : ""),
    draft,
    summaryLines: describeChanges(before, draft),
  };
}

export function undoAgentAuthorTurn(sessionId: string): AgentAuthorDraft {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("agent.session_not_found");
  const undone = session.undoMutation();
  if (!undone.ok) throw new Error(undone.reason === "conflict" ? "agent.conflict" : "agent.invalid");
  const context = session.getContext();
  if (!isAgentAuthorContext(context)) throw new Error("agent.invalid");
  return readAgentAuthorDraft(context);
}

export function parseAgentAuthorDraft(body: unknown): AgentAuthorDraft {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as AgentAuthorDraft) : {};
}
