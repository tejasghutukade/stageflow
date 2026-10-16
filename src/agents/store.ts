import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { agentDefinitionSchema, type AgentDefinition, type AgentIssue } from "../config/loadAgent.js";

/**
 * SQLite persistence for project agents (migration 013). Every method is a
 * single statement or an explicit transaction; nothing here swallows a
 * storage error. Business rules live in AgentService.
 */

export type RevisionSource = "console" | "file" | "author" | "restore" | "api";
export type SessionStatus = "open" | "running" | "waiting" | "held" | "closed";
export type TurnStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalActor = { kind: "operator" } | { kind: "channel"; channelId: string };
export type OutboundSendState = "submitted" | "unknown";

export type AgentDefinitionRow = {
  agentId: string;
  currentRevision: number;
  archived: boolean;
  fileHash: string | null;
  issues: AgentIssue[];
  createdAt: string;
  updatedAt: string;
};

export type AgentRevision = {
  agentId: string;
  revision: number;
  definition: AgentDefinition;
  yaml: string;
  source: RevisionSource;
  author: string | null;
  summary: string | null;
  restoredFrom: number | null;
  createdAt: string;
};

export type AgentRevisionMeta = Omit<AgentRevision, "definition" | "yaml">;

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

/** A session row plus rollups over its turns, for list views. */
export type AgentSessionListItem = AgentSession & {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastTurnStatus: TurnStatus | null;
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
  status: TurnStatus;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
};

export type AgentSpan = {
  id: string;
  turnId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attributes: Record<string, unknown>;
  inputText: string | null;
  outputText: string | null;
};

export type AgentApproval = {
  id: string;
  sessionId: string;
  turnId: string | null;
  tool: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  actor: ApprovalActor | null;
};

export type AgentEvalScore = { turnId: string; metric: string; score: number; recordedAt: string };

export type SessionQuery = {
  status?: SessionStatus;
  source?: string;
  search?: string;
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
};

export type SessionStats = {
  total: number;
  active: number;
  last7Days: number;
  waiting: number;
  lastActivityAt: string | null;
  /** Turns that ended in the window, and how many of those succeeded. */
  turnsFinished7d: number;
  turnsSucceeded7d: number;
  /** Sum of known turn costs in the window; null when no turn reported a cost. */
  cost7d: number | null;
};

export function agentProjectKey(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
}

type Row = Record<string, unknown>;

const str = (value: unknown): string => value as string;
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : (value as string));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toDefinitionRow(row: Row): AgentDefinitionRow {
  return {
    agentId: str(row.agent_id),
    currentRevision: Number(row.current_revision),
    archived: row.archived === 1,
    fileHash: strOrNull(row.file_hash),
    issues: row.issues_json ? (JSON.parse(str(row.issues_json)) as AgentIssue[]) : [],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toRevisionMeta(row: Row): AgentRevisionMeta {
  return {
    agentId: str(row.agent_id),
    revision: Number(row.revision),
    source: str(row.source) as RevisionSource,
    author: strOrNull(row.author),
    summary: strOrNull(row.summary),
    restoredFrom: numOrNull(row.restored_from),
    createdAt: str(row.created_at),
  };
}

/** Revisions saved before a block existed read back with that block's defaults. */
function withCurrentDefaults(stored: AgentDefinition): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(stored);
  return parsed.success ? parsed.data : stored;
}

function toRevision(row: Row): AgentRevision {
  return {
    ...toRevisionMeta(row),
    definition: withCurrentDefaults(JSON.parse(str(row.definition_json)) as AgentDefinition),
    yaml: str(row.yaml_text),
  };
}

function toSession(row: Row): AgentSession {
  return {
    id: str(row.session_id),
    agentId: str(row.agent_id),
    revision: Number(row.revision),
    backend: str(row.backend) as AgentSession["backend"],
    status: str(row.status) as SessionStatus,
    source: str(row.source),
    sourceRef: strOrNull(row.source_ref),
    threadKey: strOrNull(row.thread_key),
    title: strOrNull(row.title),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function toMessage(row: Row): AgentMessage {
  return {
    id: str(row.message_id),
    sessionId: str(row.session_id),
    seq: Number(row.seq),
    turnId: strOrNull(row.turn_id),
    role: str(row.role) as AgentMessage["role"],
    author: strOrNull(row.author),
    text: str(row.text),
    createdAt: str(row.created_at),
  };
}

function toTurn(row: Row): AgentTurn {
  return {
    id: str(row.turn_id),
    sessionId: str(row.session_id),
    seq: Number(row.seq),
    revision: Number(row.revision),
    traceId: str(row.trace_id),
    status: str(row.status) as TurnStatus,
    errorCode: strOrNull(row.error_code),
    inputTokens: numOrNull(row.input_tokens),
    outputTokens: numOrNull(row.output_tokens),
    costUsd: numOrNull(row.cost_usd),
    startedAt: str(row.started_at),
    endedAt: strOrNull(row.ended_at),
  };
}

function toSpan(row: Row): AgentSpan {
  return {
    id: str(row.span_id),
    turnId: str(row.turn_id),
    parentSpanId: strOrNull(row.parent_span_id),
    name: str(row.name),
    kind: str(row.kind),
    status: str(row.status),
    startedAt: str(row.started_at),
    endedAt: strOrNull(row.ended_at),
    durationMs: numOrNull(row.duration_ms),
    inputTokens: numOrNull(row.input_tokens),
    outputTokens: numOrNull(row.output_tokens),
    attributes: JSON.parse(str(row.attributes_json)) as Record<string, unknown>,
    inputText: strOrNull(row.input_text),
    outputText: strOrNull(row.output_text),
  };
}

function toApproval(row: Row): AgentApproval {
  return {
    id: str(row.approval_id),
    sessionId: str(row.session_id),
    turnId: strOrNull(row.turn_id),
    tool: str(row.tool),
    payload: JSON.parse(str(row.payload_json)) as Record<string, unknown>,
    payloadHash: str(row.payload_hash),
    status: str(row.status) as ApprovalStatus,
    createdAt: str(row.created_at),
    expiresAt: str(row.expires_at),
    decidedAt: strOrNull(row.decided_at),
    actor: row.actor_json ? (JSON.parse(str(row.actor_json)) as ApprovalActor) : null,
  };
}

function encodeCursor(updatedAt: string, sessionId: string): string {
  return Buffer.from(JSON.stringify([updatedAt, sessionId])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "string")) {
      return value as [string, string];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class AgentStore {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  /* ---------- definitions and revisions ---------- */

  listDefinitions(projectKey: string): AgentDefinitionRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM agent_definitions WHERE project_key = ? ORDER BY agent_id`)
        .all(projectKey) as Row[]
    ).map(toDefinitionRow);
  }

  getDefinition(projectKey: string, agentId: string): AgentDefinitionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_definitions WHERE project_key = ? AND agent_id = ?`)
      .get(projectKey, agentId) as Row | undefined;
    return row ? toDefinitionRow(row) : undefined;
  }

  /** Record the file's latest observed state without changing the revision (invalid edit, archive, restore). */
  updateDefinitionState(
    projectKey: string,
    agentId: string,
    patch: { archived?: boolean; fileHash?: string | null; issues?: AgentIssue[] },
    now: string,
  ): void {
    const current = this.getDefinition(projectKey, agentId);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE agent_definitions
           SET archived = ?, file_hash = ?, issues_json = ?, updated_at = ?
         WHERE project_key = ? AND agent_id = ?`,
      )
      .run(
        (patch.archived ?? current.archived) ? 1 : 0,
        patch.fileHash === undefined ? current.fileHash : patch.fileHash,
        JSON.stringify(patch.issues ?? current.issues),
        now,
        projectKey,
        agentId,
      );
  }

  /** Append the next revision and make it current. Returns the new revision number. */
  appendRevision(
    projectKey: string,
    input: {
      definition: AgentDefinition;
      yaml: string;
      source: RevisionSource;
      author?: string | null;
      summary?: string | null;
      restoredFrom?: number | null;
      fileHash: string;
      now: string;
    },
  ): number {
    return this.transaction(() => {
      const agentId = input.definition.id;
      const existing = this.getDefinition(projectKey, agentId);
      const revision = (existing?.currentRevision ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO agent_revisions
             (project_key, agent_id, revision, definition_json, yaml_text, source, author, summary, restored_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectKey,
          agentId,
          revision,
          JSON.stringify(input.definition),
          input.yaml,
          input.source,
          input.author ?? null,
          input.summary ?? null,
          input.restoredFrom ?? null,
          input.now,
        );
      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_definitions
               SET current_revision = ?, archived = 0, file_hash = ?, issues_json = '[]', updated_at = ?
             WHERE project_key = ? AND agent_id = ?`,
          )
          .run(revision, input.fileHash, input.now, projectKey, agentId);
      } else {
        this.db
          .prepare(
            `INSERT INTO agent_definitions
               (project_key, agent_id, current_revision, archived, file_hash, issues_json, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, '[]', ?, ?)`,
          )
          .run(projectKey, agentId, revision, input.fileHash, input.now, input.now);
      }
      return revision;
    });
  }

  /** First sighting of a file that never parsed: no revision yet, only issues. */
  recordInvalidNewDefinition(
    projectKey: string,
    agentId: string,
    fileHash: string,
    issues: AgentIssue[],
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_definitions
           (project_key, agent_id, current_revision, archived, file_hash, issues_json, created_at, updated_at)
         VALUES (?, ?, 0, 0, ?, ?, ?, ?)
         ON CONFLICT (project_key, agent_id) DO UPDATE
           SET file_hash = excluded.file_hash, issues_json = excluded.issues_json, archived = 0,
               updated_at = excluded.updated_at`,
      )
      .run(projectKey, agentId, fileHash, JSON.stringify(issues), now, now);
  }

  getRevision(projectKey: string, agentId: string, revision: number): AgentRevision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_revisions WHERE project_key = ? AND agent_id = ? AND revision = ?`)
      .get(projectKey, agentId, revision) as Row | undefined;
    return row ? toRevision(row) : undefined;
  }

  listRevisions(projectKey: string, agentId: string): AgentRevisionMeta[] {
    return (
      this.db
        .prepare(
          `SELECT agent_id, revision, source, author, summary, restored_from, created_at
             FROM agent_revisions WHERE project_key = ? AND agent_id = ? ORDER BY revision DESC`,
        )
        .all(projectKey, agentId) as Row[]
    ).map(toRevisionMeta);
  }

  /* ---------- sessions and messages ---------- */

  insertSession(projectKey: string, session: AgentSession): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (session_id, project_key, agent_id, revision, backend, status, source, source_ref, thread_key, title,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        projectKey,
        session.agentId,
        session.revision,
        session.backend,
        session.status,
        session.source,
        session.sourceRef,
        session.threadKey,
        session.title,
        session.createdAt,
        session.updatedAt,
      );
  }

  getSession(sessionId: string): (AgentSession & { projectKey: string }) | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_sessions WHERE session_id = ?`).get(sessionId) as
      | Row
      | undefined;
    return row ? { ...toSession(row), projectKey: str(row.project_key) } : undefined;
  }

  findSessionByThread(projectKey: string, agentId: string, threadKey: string): AgentSession | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE project_key = ? AND agent_id = ? AND thread_key = ?`)
      .get(projectKey, agentId, threadKey) as Row | undefined;
    return row ? toSession(row) : undefined;
  }

  updateSession(
    sessionId: string,
    patch: Partial<Pick<AgentSession, "status" | "backend" | "title">>,
    now: string,
  ): void {
    const sets: string[] = ["updated_at = @now"];
    if (patch.status !== undefined) sets.push("status = @status");
    if (patch.backend !== undefined) sets.push("backend = @backend");
    if (patch.title !== undefined) sets.push("title = @title");
    this.db
      .prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE session_id = @sessionId`)
      .run({ ...patch, now, sessionId });
  }

  listSessions(
    projectKey: string,
    agentId: string,
    query: SessionQuery,
  ): { sessions: AgentSessionListItem[]; nextCursor: string | null } {
    const where = ["project_key = @projectKey", "agent_id = @agentId"];
    const params: Record<string, unknown> = { projectKey, agentId, limit: query.limit + 1 };
    if (query.status) {
      where.push("status = @status");
      params.status = query.status;
    }
    if (query.source) {
      where.push("source = @source");
      params.source = query.source;
    }
    if (query.search) {
      where.push(
        `(title LIKE @search ESCAPE '\\' OR session_id LIKE @search ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id = agent_sessions.session_id
                     AND m.text LIKE @search ESCAPE '\\'))`,
      );
      params.search = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (cursor) {
      where.push("(updated_at < @cursorAt OR (updated_at = @cursorAt AND session_id < @cursorId))");
      params.cursorAt = cursor[0];
      params.cursorId = cursor[1];
    }
    const rows = this.db
      .prepare(
        `SELECT agent_sessions.*,
                (SELECT COUNT(*) FROM agent_turns t WHERE t.session_id = agent_sessions.session_id) AS turn_count,
                (SELECT COALESCE(SUM(input_tokens), 0) FROM agent_turns t
                  WHERE t.session_id = agent_sessions.session_id) AS input_tokens,
                (SELECT COALESCE(SUM(output_tokens), 0) FROM agent_turns t
                  WHERE t.session_id = agent_sessions.session_id) AS output_tokens,
                (SELECT SUM(cost_usd) FROM agent_turns t WHERE t.session_id = agent_sessions.session_id) AS cost_usd,
                (SELECT status FROM agent_turns t WHERE t.session_id = agent_sessions.session_id
                  ORDER BY seq DESC LIMIT 1) AS last_turn_status
           FROM agent_sessions WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, session_id DESC LIMIT @limit`,
      )
      .all(params) as Row[];
    const sessions = rows.slice(0, query.limit).map((row) => ({
      ...toSession(row),
      turnCount: Number(row.turn_count),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: numOrNull(row.cost_usd),
      lastTurnStatus: strOrNull(row.last_turn_status) as TurnStatus | null,
    }));
    const last = sessions.at(-1);
    return {
      sessions,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
    };
  }

  /** One visitor's sessions on one agent, newest first (public web chat). */
  listSessionsForRef(projectKey: string, agentId: string, source: string, sourceRef: string, limit: number): AgentSession[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM agent_sessions
            WHERE project_key = ? AND agent_id = ? AND source = ? AND source_ref = ?
            ORDER BY updated_at DESC, session_id DESC LIMIT ?`,
        )
        .all(projectKey, agentId, source, sourceRef, limit) as Row[]
    ).map(toSession);
  }

  sessionStats(projectKey: string, agentId: string, since: string): SessionStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('running', 'waiting') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
                SUM(CASE WHEN created_at >= @since THEN 1 ELSE 0 END) AS recent,
                MAX(updated_at) AS last_activity
           FROM agent_sessions WHERE project_key = @projectKey AND agent_id = @agentId`,
      )
      .get({ projectKey, agentId, since }) as Row;
    const turns = this.db
      .prepare(
        `SELECT SUM(CASE WHEN t.status IN ('succeeded', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS finished,
                SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(t.cost_usd) AS cost
           FROM agent_turns t JOIN agent_sessions s ON s.session_id = t.session_id
          WHERE s.project_key = @projectKey AND s.agent_id = @agentId AND t.started_at >= @since`,
      )
      .get({ projectKey, agentId, since }) as Row;
    return {
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      waiting: Number(row.waiting ?? 0),
      last7Days: Number(row.recent ?? 0),
      lastActivityAt: strOrNull(row.last_activity),
      turnsFinished7d: Number(turns.finished ?? 0),
      turnsSucceeded7d: Number(turns.succeeded ?? 0),
      cost7d: numOrNull(turns.cost),
    };
  }

  /** Mark every non-terminal session of an agent held (disable/archive while work is queued). */
  holdOpenSessions(projectKey: string, agentId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE agent_sessions SET status = 'held', updated_at = ?
          WHERE project_key = ? AND agent_id = ? AND status = 'open'`,
      )
      .run(now, projectKey, agentId);
  }

  appendMessage(message: Omit<AgentMessage, "seq">): AgentMessage {
    const seq = Number(
      (
        this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_messages WHERE session_id = ?`)
          .get(message.sessionId) as Row
      ).next,
    );
    this.db
      .prepare(
        `INSERT INTO agent_messages (message_id, session_id, seq, turn_id, role, author, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.sessionId, seq, message.turnId, message.role, message.author, message.text, message.createdAt);
    return { ...message, seq };
  }

  listMessages(sessionId: string): AgentMessage[] {
    return (
      this.db.prepare(`SELECT * FROM agent_messages WHERE session_id = ? ORDER BY seq`).all(sessionId) as Row[]
    ).map(toMessage);
  }

  /* ---------- turns, spans, evals ---------- */

  insertTurn(turn: Omit<AgentTurn, "seq">): AgentTurn {
    const seq = Number(
      (
        this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_turns WHERE session_id = ?`)
          .get(turn.sessionId) as Row
      ).next,
    );
    this.db
      .prepare(
        `INSERT INTO agent_turns
           (turn_id, session_id, seq, revision, trace_id, status, error_code, input_tokens, output_tokens, cost_usd,
            started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.sessionId,
        seq,
        turn.revision,
        turn.traceId,
        turn.status,
        turn.errorCode,
        turn.inputTokens,
        turn.outputTokens,
        turn.costUsd,
        turn.startedAt,
        turn.endedAt,
      );
    return { ...turn, seq };
  }

  finishTurn(
    turnId: string,
    patch: Pick<AgentTurn, "status" | "errorCode" | "inputTokens" | "outputTokens" | "costUsd" | "endedAt">,
  ): void {
    this.db
      .prepare(
        `UPDATE agent_turns
            SET status = @status, error_code = @errorCode, input_tokens = @inputTokens,
                output_tokens = @outputTokens, cost_usd = @costUsd, ended_at = @endedAt
          WHERE turn_id = @turnId`,
      )
      .run({ ...patch, turnId });
  }

  setTurnStatus(turnId: string, status: TurnStatus): void {
    this.db.prepare(`UPDATE agent_turns SET status = ? WHERE turn_id = ?`).run(status, turnId);
  }

  getTurn(turnId: string): AgentTurn | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_turns WHERE turn_id = ?`).get(turnId) as Row | undefined;
    return row ? toTurn(row) : undefined;
  }

  listTurns(sessionId: string): AgentTurn[] {
    return (
      this.db.prepare(`SELECT * FROM agent_turns WHERE session_id = ? ORDER BY seq`).all(sessionId) as Row[]
    ).map(toTurn);
  }

  /** Turns left `running` by a host that stopped mid-turn. */
  failInterruptedTurns(now: string): number {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE agent_turns SET status = 'failed', error_code = 'agent.host_restarted', ended_at = ?
            WHERE status IN ('running', 'waiting')`,
        )
        .run(now);
      this.db
        .prepare(`UPDATE agent_sessions SET status = 'open', updated_at = ? WHERE status IN ('running', 'waiting')`)
        .run(now);
      this.db
        .prepare(`UPDATE agent_approvals SET status = 'expired' WHERE status = 'pending'`)
        .run();
      return result.changes;
    });
  }

  insertSpan(span: AgentSpan): void {
    this.db
      .prepare(
        `INSERT INTO agent_spans
           (span_id, turn_id, parent_span_id, name, kind, status, started_at, ended_at, duration_ms,
            input_tokens, output_tokens, attributes_json, input_text, output_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        span.id,
        span.turnId,
        span.parentSpanId,
        span.name,
        span.kind,
        span.status,
        span.startedAt,
        span.endedAt,
        span.durationMs,
        span.inputTokens,
        span.outputTokens,
        JSON.stringify(span.attributes),
        span.inputText,
        span.outputText,
      );
  }

  listSpansForTurn(turnId: string): AgentSpan[] {
    return (
      this.db.prepare(`SELECT * FROM agent_spans WHERE turn_id = ? ORDER BY started_at, span_id`).all(turnId) as Row[]
    ).map(toSpan);
  }

  listSpansForSession(sessionId: string): AgentSpan[] {
    return (
      this.db
        .prepare(
          `SELECT s.* FROM agent_spans s JOIN agent_turns t ON t.turn_id = s.turn_id
            WHERE t.session_id = ? ORDER BY t.seq, s.started_at, s.span_id`,
        )
        .all(sessionId) as Row[]
    ).map(toSpan);
  }

  recordEvalScore(score: AgentEvalScore): void {
    this.db
      .prepare(
        `INSERT INTO agent_eval_scores (turn_id, metric, score, recorded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (turn_id, metric) DO UPDATE SET score = excluded.score, recorded_at = excluded.recorded_at`,
      )
      .run(score.turnId, score.metric, score.score, score.recordedAt);
  }

  listEvalScores(sessionId: string): AgentEvalScore[] {
    return (
      this.db
        .prepare(
          `SELECT e.* FROM agent_eval_scores e JOIN agent_turns t ON t.turn_id = e.turn_id
            WHERE t.session_id = ? ORDER BY t.seq`,
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      turnId: str(row.turn_id),
      metric: str(row.metric),
      score: Number(row.score),
      recordedAt: str(row.recorded_at),
    }));
  }

  /* ---------- approvals ---------- */

  insertApproval(approval: AgentApproval): void {
    this.db
      .prepare(
        `INSERT INTO agent_approvals
           (approval_id, session_id, turn_id, tool, payload_json, payload_hash, status, created_at, expires_at,
            decided_at, actor_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.turnId,
        approval.tool,
        JSON.stringify(approval.payload),
        approval.payloadHash,
        approval.status,
        approval.createdAt,
        approval.expiresAt,
        approval.decidedAt,
        approval.actor ? JSON.stringify(approval.actor) : null,
      );
  }

  getPendingApproval(sessionId: string): AgentApproval | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_approvals WHERE session_id = ? AND status = 'pending'`)
      .get(sessionId) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  findApprovalByPayload(sessionId: string, payloadHash: string): AgentApproval | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_approvals WHERE session_id = ? AND payload_hash = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId, payloadHash) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  listApprovals(sessionId: string): AgentApproval[] {
    return (
      this.db
        .prepare(`SELECT * FROM agent_approvals WHERE session_id = ? ORDER BY created_at`)
        .all(sessionId) as Row[]
    ).map(toApproval);
  }

  listPendingApprovals(projectKey: string): Array<AgentApproval & { agentId: string }> {
    return (
      this.db
        .prepare(
          `SELECT a.*, s.agent_id FROM agent_approvals a JOIN agent_sessions s ON s.session_id = a.session_id
            WHERE s.project_key = ? AND a.status = 'pending' ORDER BY a.created_at`,
        )
        .all(projectKey) as Row[]
    ).map((row) => ({ ...toApproval(row), agentId: str(row.agent_id) }));
  }

  decideApproval(
    approvalId: string,
    patch: { status: Exclude<ApprovalStatus, "pending">; decidedAt: string; actor: ApprovalActor | null },
  ): void {
    this.db
      .prepare(
        `UPDATE agent_approvals SET status = ?, decided_at = ?, actor_json = ?
          WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(patch.status, patch.decidedAt, patch.actor ? JSON.stringify(patch.actor) : null, approvalId);
  }

  /** Expire every pending approval past its deadline; returns the affected session ids. */
  expireApprovals(now: string): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT approval_id, session_id FROM agent_approvals WHERE status = 'pending' AND expires_at <= ?`)
        .all(now) as Row[];
      for (const row of rows) {
        this.decideApproval(str(row.approval_id), { status: "expired", decidedAt: now, actor: null });
      }
      return [...new Set(rows.map((row) => str(row.session_id)))];
    });
  }

  markPayloadExecuted(sessionId: string, payloadHash: string, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_executed_payloads (session_id, payload_hash, executed_at) VALUES (?, ?, ?)`,
      )
      .run(sessionId, payloadHash, now);
  }

  hasExecutedPayload(sessionId: string, payloadHash: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM agent_executed_payloads WHERE session_id = ? AND payload_hash = ?`)
        .get(sessionId, payloadHash) !== undefined
    );
  }

  /* ---------- communications and schedules ---------- */

  /** True the first time a provider event is seen for this project. */
  rememberInboundEvent(projectKey: string, dedupeKey: string, now: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_inbound_events (project_key, dedupe_key, received_at) VALUES (?, ?, ?)`,
        )
        .run(projectKey, dedupeKey, now).changes === 1
    );
  }

  getOutboundState(sessionId: string, operationKey: string): OutboundSendState | undefined {
    const row = this.db
      .prepare(`SELECT state FROM agent_outbound_sends WHERE session_id = ? AND operation_key = ?`)
      .get(sessionId, operationKey) as Row | undefined;
    return row ? (str(row.state) as OutboundSendState) : undefined;
  }

  setOutboundState(sessionId: string, operationKey: string, state: OutboundSendState, now: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_outbound_sends (session_id, operation_key, state, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, operation_key) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(sessionId, operationKey, state, now);
  }

  getScheduleNextRun(projectKey: string, agentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT next_run_at FROM agent_schedules WHERE project_key = ? AND agent_id = ?`)
      .get(projectKey, agentId) as Row | undefined;
    return row ? str(row.next_run_at) : undefined;
  }

  setScheduleNextRun(projectKey: string, agentId: string, nextRunAt: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_schedules (project_key, agent_id, next_run_at) VALUES (?, ?, ?)
         ON CONFLICT (project_key, agent_id) DO UPDATE SET next_run_at = excluded.next_run_at`,
      )
      .run(projectKey, agentId, nextRunAt);
  }

  clearSchedule(projectKey: string, agentId: string): void {
    this.db.prepare(`DELETE FROM agent_schedules WHERE project_key = ? AND agent_id = ?`).run(projectKey, agentId);
  }
}
