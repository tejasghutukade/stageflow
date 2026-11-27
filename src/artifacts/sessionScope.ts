import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { SlidingWindowLimiter } from "../util/slidingWindowLimiter.js";
import { ArtifactPublishError } from "./limits.js";
import { deleteOriginApprovals } from "./originApproval.js";
import { ArtifactQueryError } from "./query.js";
import { unindexArtifactSearch } from "./search.js";
import { removeStoredArtifact } from "./store.js";

export const SESSION_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ARTIFACTS_PER_SESSION = 32;
export const SESSION_ARTIFACTS_PER_MESSAGE = 4;
export const SESSION_ARTIFACT_RATE_LIMIT = 12;
export const SESSION_ARTIFACT_RATE_WINDOW_MS = 60_000;

let limiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);

export function resetSessionArtifactLimiterForTests(): void {
  limiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);
}

export function sessionArtifactExpiresAt(nowMs: number): string {
  return new Date(nowMs + SESSION_ARTIFACT_TTL_MS).toISOString();
}

export function newSessionArtifactId(): string {
  return `c${randomBytes(8).toString("hex")}`;
}

export function assertSessionArtifactCaps(
  db: Database.Database,
  sessionId: string,
  presentedInMessage: number,
  nowMs: number,
): void {
  const rate = limiter.take(sessionId, SESSION_ARTIFACT_RATE_LIMIT, nowMs);
  if (!rate.ok) {
    throw new ArtifactPublishError(
      429,
      "ui.rate_limited",
      `Too many session artifacts. Try again in ${rate.retryAfterSec}s`,
      [{ path: "program", message: `Too many session artifacts. Try again in ${rate.retryAfterSec}s` }],
    );
  }
  if (presentedInMessage > SESSION_ARTIFACTS_PER_MESSAGE) {
    throw new ArtifactPublishError(429, "ui.message_cap", "This message already has the maximum number of session artifacts", [
      { path: "program", message: "This message already has the maximum number of session artifacts" },
    ]);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM artifacts
       WHERE scope = 'session' AND source_session_id = ? AND deleted_at IS NULL AND status = 'available'`,
    )
    .get(sessionId) as { n: number };
  if (Number(row.n) >= SESSION_ARTIFACTS_PER_SESSION) {
    throw new ArtifactPublishError(429, "ui.session_cap", "This conversation already has the maximum number of session artifacts", [
      { path: "program", message: "This conversation already has the maximum number of session artifacts" },
    ]);
  }
}

export function promoteSessionArtifact(db: Database.Database, storageKey: string, now = new Date().toISOString()): void {
  const row = db.prepare(`SELECT scope, hidden, status, deleted_at FROM artifacts WHERE key = ?`).get(storageKey) as
    | { scope: string | null; hidden: number; status: string | null; deleted_at: string | null }
    | undefined;
  if (row === undefined || row.deleted_at !== null || row.hidden !== 0) {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (row.scope !== "session") {
    throw new ArtifactQueryError(409, "artifact.not_session", "That artifact is already kept");
  }
  if (row.status === "expired") {
    throw new ArtifactQueryError(409, "artifact.expired", "An expired session artifact cannot be kept");
  }
  db.prepare(`UPDATE artifacts SET scope = 'project', expires_at = NULL, updated_at = ? WHERE key = ?`).run(now, storageKey);
}

export function expireDueSessionArtifacts(db: Database.Database, now: string): number {
  const rows = db
    .prepare(
      `SELECT key FROM artifacts
       WHERE scope = 'session' AND status = 'available' AND deleted_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(now) as Array<{ key: string }>;
  if (rows.length === 0) return 0;
  db.transaction(() => {
    db.prepare(
      `UPDATE artifacts
       SET status = 'expired',
           expired_at = COALESCE(expired_at, @now),
           expired_reason = COALESCE(expired_reason, 'session_expired')
       WHERE scope = 'session' AND status = 'available' AND deleted_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= @now`,
    ).run({ now });
    for (const row of rows) unindexArtifactSearch(db, row.key);
  })();
  return rows.length;
}

export async function purgeSessionArtifacts(db: Database.Database, sessionIds: readonly string[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT key FROM artifacts WHERE scope = 'session' AND source_session_id IN (${sessionIds.map(() => "?").join(", ")})`,
    )
    .all(...sessionIds) as Array<{ key: string }>;
  for (const row of rows) {
    db.transaction(() => {
      unindexArtifactSearch(db, row.key);
      deleteOriginApprovals(db, [row.key]);
      db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(row.key);
      db.prepare(`DELETE FROM artifact_attempt_publishes WHERE artifact_key = ?`).run(row.key);
      db.prepare(`DELETE FROM artifact_versions WHERE key = ?`).run(row.key);
      db.prepare(`DELETE FROM artifacts WHERE key = ?`).run(row.key);
    })();
    try {
      await removeStoredArtifact(row.key);
    } catch (error) {
      console.error(
        `session artifact purge: failed to remove store directory for ${row.key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return rows.length;
}
