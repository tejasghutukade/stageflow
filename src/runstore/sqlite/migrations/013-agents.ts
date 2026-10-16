import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Project agents: revisions, sessions, transcript, approvals, turns, spans.
 * Read and written only by `AgentStore` (src/agents/store.ts); kept out of the
 * run/stage-shaped RunStore port. `project_key` scopes rows to one project root.
 */
export const MIGRATION_013 = {
  version: 13,
  name: "013_agents",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE agent_definitions (
  project_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT,
  issues_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, agent_id)
);

CREATE TABLE agent_revisions (
  project_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  yaml_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('console', 'file', 'author', 'restore', 'api')),
  author TEXT,
  summary TEXT,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_key, agent_id, revision)
);

CREATE TABLE agent_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  project_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  backend TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'running', 'waiting', 'held', 'closed')),
  source TEXT NOT NULL,
  source_ref TEXT,
  thread_key TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_sessions_agent_updated ON agent_sessions (project_key, agent_id, updated_at DESC);
CREATE UNIQUE INDEX agent_sessions_thread ON agent_sessions (project_key, agent_id, thread_key)
  WHERE thread_key IS NOT NULL;

CREATE TABLE agent_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  author TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE agent_turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (session_id, seq)
);

CREATE TABLE agent_spans (
  span_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES agent_turns (turn_id) ON DELETE CASCADE,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  input_text TEXT,
  output_text TEXT
);
CREATE INDEX agent_spans_turn ON agent_spans (turn_id, started_at);

CREATE TABLE agent_eval_scores (
  turn_id TEXT NOT NULL REFERENCES agent_turns (turn_id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  score REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, metric)
);

CREATE TABLE agent_approvals (
  approval_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  turn_id TEXT,
  tool TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  actor_json TEXT
);
CREATE UNIQUE INDEX agent_approvals_one_pending ON agent_approvals (session_id) WHERE status = 'pending';

CREATE TABLE agent_executed_payloads (
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, payload_hash)
);

CREATE TABLE agent_outbound_sends (
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'unknown')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, operation_key)
);

CREATE TABLE agent_inbound_events (
  project_key TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (project_key, dedupe_key)
);

CREATE TABLE agent_schedules (
  project_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  PRIMARY KEY (project_key, agent_id)
);
`);
  },
};
