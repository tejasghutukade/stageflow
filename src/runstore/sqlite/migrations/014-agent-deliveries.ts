import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Replies to people on a channel (AgentMail, iMessage): one row per turn that has to reach someone, with how
 * the send went, so a failed reply can be retried or resent and a reply of unknown outcome is never duplicated.
 */
export const MIGRATION_014 = {
  version: 14,
  name: "014_agent_deliveries",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE agent_deliveries (
  turn_id TEXT PRIMARY KEY REFERENCES agent_turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions (session_id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  reply_to TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'delivered', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_deliveries_due ON agent_deliveries (state, next_attempt_at);
CREATE INDEX agent_deliveries_session ON agent_deliveries (session_id);
`);
  },
};
