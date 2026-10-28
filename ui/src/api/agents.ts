import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

/** Wire types for `/api/agents` — mirror src/config/loadAgent.ts and src/agents/{service,store}.ts. */

export type BuiltinToolGroup = "read" | "write" | "shell";
export type ThinkingLevel = "off" | "low" | "medium" | "high";
export type CaptureMode = "off" | "metadata" | "full";

/** Public chat page. `slug` is the server-generated link credential; omit it on a save to get a new one (rotate). */
export type WebChatConfig = {
  enabled: boolean;
  slug?: string;
  rate_limit_per_minute: number;
  max_message_chars: number;
};

export type AgentDefinition = {
  id: string;
  name: string;
  description?: string;
  greeting?: string;
  enabled: boolean;
  instructions: string;
  project_context: boolean;
  execution: "trusted-local" | "sandbox";
  model: { backend: "pi" | "claude"; id?: string; thinking: ThinkingLevel };
  tools: { builtin: BuiltinToolGroup[]; builtin_tools: string[]; mcp: Record<string, string[]>; skills: string[]; browser: boolean; stageflow: { groups: string[]; tools: string[] } };
  approvals: {
    ask_first: string[];
    approvers: { operators: boolean; channel_ids: string[] };
    timeout_minutes: number;
    on_timeout: "skip" | "deny";
  };
  sub_agents: string[];
  sub_agent_depth: number;
  guardrails: { block_patterns: string[] };
  evals: { groundedness: boolean };
  observability: { capture: CaptureMode; otlp: boolean };
  channel?: { connection_id: string; allow_from: string[] };
  memories?: string[];
  schedule?: { cron: string; timezone?: string; message?: string };
  web_chat: WebChatConfig;
  limits: {
    session_minutes: number;
    max_turns: number;
    cost_usd: number | null;
    long_context: "summarize" | "truncate";
    always_on: boolean;
  };
};

export type AgentIssue = { path: string; code: string; message: string; line?: number; column?: number };

export type SessionStats = {
  total: number;
  active: number;
  last7Days: number;
  waiting: number;
  lastActivityAt: string | null;
  turnsFinished7d: number;
  turnsSucceeded7d: number;
  cost7d: number | null;
  costTotal: number | null;
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  revision: number;
  issues: AgentIssue[];
  model: AgentDefinition["model"] | null;
  tools: { builtin: BuiltinToolGroup[]; builtinTools: string[]; mcpServers: string[]; skills: string[]; browser: boolean };
  askFirst: string[];
  channelConnection: string | null;
  scheduleCron?: string | null;
  subAgents: string[];
  capture: CaptureMode | null;
  stats: SessionStats;
  pendingApprovals: number;
  updatedAt: string;
  /** Path form `/chat/<slug>` once web chat has a slug; the console prefixes the address it is opened from. */
  webChatUrl?: string | null;
};

export type AgentDetail = {
  agent: AgentSummary;
  definition: AgentDefinition | null;
  yaml: string | null;
  warnings: AgentIssue[];
};

export type AgentValidation = {
  definition: AgentDefinition | null;
  issues: AgentIssue[];
  warnings: AgentIssue[];
  yaml: string | null;
};

export type RevisionSource = "console" | "file" | "author" | "restore" | "api";

export type AgentRevisionMeta = {
  agentId: string;
  revision: number;
  source: RevisionSource;
  author: string | null;
  summary: string | null;
  restoredFrom: number | null;
  createdAt: string;
};

export type AgentRevision = AgentRevisionMeta & { definition: AgentDefinition; yaml: string };

export type DiffLine = { kind: "same" | "added" | "removed"; text: string; before?: number; after?: number };

export type SessionStatus = "open" | "running" | "waiting" | "held" | "closed";

export type AgentSession = {
  id: string;
  agentId: string;
  revision: number;
  backend: "pi" | "claude";
  status: SessionStatus;
  source: string;
  sourceRef: string | null;
  threadKey: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMessage = {
  id: string;
  sessionId: string;
  seq: number;
  turnId: string | null;
  role: "user" | "assistant";
  author: string | null;
  text: string;
  createdAt: string;
};

export type AgentTurn = {
  id: string;
  sessionId: string;
  seq: number;
  revision: number;
  traceId: string;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
};

export type AgentApproval = {
  id: string;
  sessionId: string;
  turnId: string | null;
  tool: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  actor: { kind: "operator" } | { kind: "channel"; channelId: string } | null;
};

export type ChannelContact =
  | { ok: true; kind: "dedicated"; numbers: string[] }
  | { ok: true; kind: "shared"; users: Array<{ phone: string; assignedNumber: string | null; name: string | null }> }
  | { ok: false; error: string };

export type ChannelListenerState = {
  status: "starting" | "connected" | "reconnecting" | "failed" | "stopped";
  since: string;
  error?: string;
  received: number;
};

export type StageflowToolRisk = "read" | "write" | "destructive" | "external";

export type StageflowToolCatalog = {
  groups: Array<{
    id: string;
    title: string;
    summary: string;
    operatorOnly: boolean;
    tools: Array<{ name: string; grantId: string; risk: StageflowToolRisk; description: string; operatorOnly: boolean }>;
  }>;
};

export type AgentSpan = {
  id: string;
  turnId: string;
  parentSpanId: string | null;
  name: string;
  kind: "agent" | "model" | "tool" | "sub_agent" | "guardrail" | "gate" | "internal" | string;
  status: "ok" | "error" | "cancelled" | string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attributes: Record<string, unknown>;
  inputText: string | null;
  outputText: string | null;
};

export type AgentDelivery = {
  turnId: string;
  sessionId: string;
  connectionId: string;
  provider: string;
  replyTo: string;
  text: string;
  state: "pending" | "sending" | "delivered" | "failed" | "unknown";
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionDetail = {
  session: AgentSession;
  messages: AgentMessage[];
  turns: AgentTurn[];
  spans: AgentSpan[];
  approvals: AgentApproval[];
  pendingApproval: AgentApproval | null;
  evalScores: Array<{ turnId: string; metric: string; score: number; recordedAt: string }>;
  deliveries: AgentDelivery[];
};

export type AgentSessionListItem = AgentSession & {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastTurnStatus: AgentTurn["status"] | null;
};

export type SessionPage = { sessions: AgentSessionListItem[]; nextCursor: string | null; stats: SessionStats };

export class AgentApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly issues: AgentIssue[] = [],
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  const parsed = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string; issues?: AgentIssue[] };
  if (!res.ok) {
    const code = typeof parsed.code === "string" ? parsed.code : `http_${res.status}`;
    throw new AgentApiError(code, res.status, parsed.message ?? code, parsed.issues ?? []);
  }
  return parsed;
}

const enc = encodeURIComponent;
const agentUrl = (id: string, tail = "") => `/api/agents/${enc(id)}${tail}`;

export const agentsApi = {
  list: () => request<{ agents: AgentSummary[] }>("/api/agents").then((body) => body.agents),
  get: (id: string) => request<AgentDetail>(agentUrl(id)),
  validate: (definition: unknown) => request<AgentValidation>("/api/agents/validate", "POST", { definition }),
  /** Send a reply that failed or whose outcome was unknown again. */
  resendReply: (id: string, sessionId: string, turnId: string) =>
    request<AgentSessionDetail>(agentUrl(id, `/sessions/${enc(sessionId)}/turns/${enc(turnId)}/delivery/resend`), "POST"),
  /** Confirm a reply did reach the person. */
  markReplyDelivered: (id: string, sessionId: string, turnId: string) =>
    request<AgentSessionDetail>(agentUrl(id, `/sessions/${enc(sessionId)}/turns/${enc(turnId)}/delivery/delivered`), "POST"),
  channelContact: (id: string) =>
    request<{ connectionId: string | null; provider?: string; contact?: ChannelContact }>(agentUrl(id, "/channel/contact")),
  channelStatus: (id: string) =>
    request<{ connectionId: string | null; listener?: ChannelListenerState; lastUndelivered?: { turnId: string; sessionId: string; state: string; code: string | null; message: string | null; at: string } }>(agentUrl(id, "/channel")),
  stageflowTools: () => request<StageflowToolCatalog>("/api/agents/stageflow-tools"),
  create: (definition: unknown) => request<AgentDetail>("/api/agents", "POST", { definition }),
  save: (id: string, input: { baseRevision: number; definition: unknown; summary?: string }) =>
    request<AgentDetail>(agentUrl(id, "/save"), "POST", input),
  setEnabled: (id: string, enabled: boolean) => request<AgentDetail>(agentUrl(id, enabled ? "/enable" : "/disable"), "POST"),
  archive: (id: string) => request<{ archived: true }>(agentUrl(id, "/archive"), "POST"),
  revisions: (id: string) =>
    request<{ revisions: AgentRevisionMeta[] }>(agentUrl(id, "/revisions")).then((body) => body.revisions),
  revision: (id: string, revision: number) => request<AgentRevision>(agentUrl(id, `/revisions/${revision}`)),
  diff: (id: string, from: number, to: number) =>
    request<{ lines: DiffLine[] }>(agentUrl(id, `/revisions/${from}/diff/${to}`)).then((body) => body.lines),
  restore: (id: string, revision: number, baseRevision: number) =>
    request<AgentDetail>(agentUrl(id, `/revisions/${revision}/restore`), "POST", { baseRevision }),
  sessions: (
    id: string,
    query: { status?: SessionStatus; source?: string; q?: string; cursor?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const qs = params.toString();
    return request<SessionPage>(agentUrl(id, `/sessions${qs ? `?${qs}` : ""}`));
  },
  allSessions: (
    query: { agent?: string; status?: SessionStatus; source?: string; q?: string; cursor?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const qs = params.toString();
    return request<SessionPage>(`/api/agents/sessions${qs ? `?${qs}` : ""}`);
  },
  session: (id: string, sessionId: string) => request<AgentSessionDetail>(agentUrl(id, `/sessions/${enc(sessionId)}`)),
  decide: (id: string, sessionId: string, decision: "approve" | "deny") =>
    request<{ approval: AgentApproval; session: AgentSessionDetail }>(
      agentUrl(id, `/sessions/${enc(sessionId)}/approval/${decision}`),
      "POST",
    ),
  pendingApprovals: () =>
    request<{ approvals: Array<AgentApproval & { agentId: string }> }>("/api/agents/approvals").then(
      (body) => body.approvals,
    ),
  /** Download the session's traces as OTLP/JSON. */
  async exportOtlp(id: string, sessionId: string): Promise<Blob> {
    const res = await fetch(agentUrl(id, `/sessions/${enc(sessionId)}/otlp`), { headers: authorizationHeaders() });
    if (res.status === 401) notifyControlTokenRequired();
    if (!res.ok) throw new AgentApiError(`http_${res.status}`, res.status, "Export failed");
    return res.blob();
  },
  stop: (id: string, sessionId: string) => request<{ stopped: boolean }>(agentUrl(id, "/chat/stop"), "POST", { sessionId }),
};

/**
 * Stream one chat turn. Deltas arrive as they are generated; the promise
 * resolves with the stored session detail, or throws AgentApiError.
 */
export async function streamAgentChat(
  id: string,
  input: { message: string; sessionId?: string },
  handlers: { onDelta?: (text: string) => void; onSession?: (sessionId: string) => void; signal?: AbortSignal } = {},
): Promise<AgentSessionDetail> {
  const res = await fetch(agentUrl(id, "/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", ...authorizationHeaders() },
    body: JSON.stringify({ ...input, stream: true }),
    ...(handlers.signal ? { signal: handlers.signal } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new AgentApiError(body.code ?? `http_${res.status}`, res.status, body.message ?? body.code ?? "Chat failed");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      const frame = JSON.parse(line) as {
        type: string;
        text?: string;
        sessionId?: string;
        session?: AgentSessionDetail;
        code?: string;
        message?: string;
      };
      if (frame.type === "delta" && frame.text) handlers.onDelta?.(frame.text);
      else if (frame.type === "session" && frame.sessionId) handlers.onSession?.(frame.sessionId);
      else if (frame.type === "done" && frame.session) return frame.session;
      else if (frame.type === "error") {
        throw new AgentApiError(frame.code ?? "agent.internal", 200, frame.message ?? frame.code ?? "Chat failed");
      }
    }
  }
  throw new AgentApiError("agent.stream_ended", 200, "The connection closed before the reply finished");
}

/* ---------- agent author (unsaved-draft chat) ---------- */

/** The author's unsaved draft: any subset of the definition while it is still being described. */
export type AgentAuthorDraft = Record<string, unknown>;

export type AgentAuthorTurnResult = {
  sessionId: string;
  /** The author's reply to show in the chat. */
  text: string;
  draft: AgentAuthorDraft;
  /** One line per config section the turn changed; empty when it only talked. */
  summaryLines: { label: string; value: string }[];
};

export function sendAgentAuthorTurn(input: {
  message: string;
  sessionId?: string;
  draft: AgentAuthorDraft;
  /** Chosen chat model. Blank lets the host use its default. */
  model?: string;
}): Promise<AgentAuthorTurnResult> {
  return request("/api/agent-author/chat", "POST", input);
}

export type AuthorSessionRecord = {
  id: string;
  draft: AgentAuthorDraft;
  model?: string;
  transcript: Array<{ id: string; role: "user" | "assistant"; text: string; summaryLines?: { label: string; value: string }[] }>;
};

export function createAuthorSession(draft: AgentAuthorDraft, model?: string): Promise<AuthorSessionRecord> {
  return request("/api/agent-author/sessions", "POST", { draft, ...(model ? { model } : {}) });
}

export function getAuthorSession(sessionId: string): Promise<AuthorSessionRecord> {
  return request(`/api/agent-author/sessions/${encodeURIComponent(sessionId)}`);
}

export function listAuthorDrafts(): Promise<{ drafts: Array<{ id: string; name: string; updatedAt: string; messages: number }> }> {
  return request("/api/agent-author/sessions");
}

export function saveAuthorDraft(sessionId: string, draft: AgentAuthorDraft): Promise<AuthorSessionRecord> {
  return request(`/api/agent-author/sessions/${encodeURIComponent(sessionId)}`, "PUT", { draft });
}

export function deleteAuthorSession(sessionId: string): Promise<{ removed: true }> {
  return request(`/api/agent-author/sessions/${encodeURIComponent(sessionId)}`, "DELETE");
}

export function undoAgentAuthorTurn(sessionId: string): Promise<{ draft: AgentAuthorDraft }> {
  return request("/api/agent-author/undo", "POST", { sessionId });
}
