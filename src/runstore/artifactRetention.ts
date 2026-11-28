import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { ArtifactExpiredReason } from "../artifacts/record.js";
import { PATH_DENIED_MESSAGE, resolveContainedRelativePath } from "../runread/readArtifact.js";
import {
  artifactSearchBodyKind,
  extractSearchBody,
  readBoundedSearchFile,
  reindexArtifactSearchKey,
  repairDirtyArtifactSearch,
  unindexArtifactSearch,
} from "../artifacts/search.js";
import { recoverRefreshingArtifacts } from "../artifacts/refresh.js";
import { retentionWindowsFromEnv } from "./retention.js";
import { attemptArtifactsDir } from "./workspaceLayout.js";

/** Available indexed rows of terminal runs inspected per retention sweep. */
export const INDEXED_ARTIFACT_REPAIR_BATCH = 100;

export function logArtifactIndexFailure(scope: string, error: unknown): void {
  console.error(
    `${scope}: artifact index update failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

const PATH_MESSAGES = {
  relativeRequired: "path must be relative to the run workspace",
  escapes: "path escapes the run workspace",
  notFound: (relativePath: string) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

type IndexedFileRow = {
  key: string;
  source_stage_id: string | null;
  source_attempt: number | null;
  relative_path: string | null;
};

/**
 * Purge time for an indexed artifact, from the run retention window.
 * Null until the run has a terminal status and a finished_at.
 */
export function indexedExpiresAt(
  status: string,
  finishedAt: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (finishedAt == null || finishedAt === "") return null;
  const windows = retentionWindowsFromEnv(env);
  const window =
    status === "succeeded"
      ? windows.succeeded
      : status === "failed"
        ? windows.failed
        : status === "cancelled"
          ? windows.cancelled
          : undefined;
  if (window === undefined) return null;
  const ms = Date.parse(finishedAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + window.purgeMs).toISOString();
}

/** Set expires_at once. Rows that already have one are left alone. */
export function stampIndexedExpiresAt(
  db: Database.Database,
  runId: string,
  status: string,
  finishedAt: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expires = indexedExpiresAt(status, finishedAt, env);
  if (expires == null) return;
  db.prepare(
    `UPDATE artifacts
     SET expires_at = @expires
     WHERE origin = 'indexed'
       AND source_run_id = @run_id
       AND expires_at IS NULL
       AND deleted_at IS NULL`,
  ).run({ expires, run_id: runId });
}

export function expireIndexedRun(
  db: Database.Database,
  runId: string,
  reason: ArtifactExpiredReason,
  now: string,
): void {
  db.transaction(() => {
    const keys = db
      .prepare(
        `SELECT key FROM artifacts
         WHERE origin = 'indexed'
           AND source_run_id = ?
           AND status = 'available'
           AND deleted_at IS NULL`,
      )
      .all(runId) as { key: string }[];
    db.prepare(
      `UPDATE artifacts
       SET status = 'expired',
           expired_at = COALESCE(expired_at, @now),
           expired_reason = COALESCE(expired_reason, @reason)
       WHERE origin = 'indexed'
         AND source_run_id = @run_id
         AND status = 'available'
         AND deleted_at IS NULL`,
    ).run({ run_id: runId, reason, now });
    for (const row of keys) unindexArtifactSearch(db, row.key);
  })();
}

function expireKeys(
  db: Database.Database,
  keys: readonly string[],
  reason: ArtifactExpiredReason,
  now: string,
): void {
  const chunkSize = 80;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const slice = keys.slice(offset, offset + chunkSize);
    const params: Record<string, string> = { now, reason };
    slice.forEach((key, index) => {
      params[`k${index}`] = key;
    });
    const names = slice.map((_, index) => `@k${index}`).join(", ");
    db.transaction(() => {
      const keys = db
        .prepare(
          `SELECT key FROM artifacts
           WHERE key IN (${names})
             AND origin = 'indexed'
             AND status = 'available'
             AND deleted_at IS NULL`,
        )
        .all(params) as { key: string }[];
      db.prepare(
        `UPDATE artifacts
         SET status = 'expired',
             expired_at = COALESCE(expired_at, @now),
             expired_reason = COALESCE(expired_reason, @reason)
         WHERE key IN (${names})
           AND origin = 'indexed'
           AND status = 'available'
           AND deleted_at IS NULL`,
      ).run(params);
      for (const row of keys) unindexArtifactSearch(db, row.key);
    })();
  }
}

async function containedFile(
  workspaceDir: string,
  row: IndexedFileRow,
): Promise<{ realPath: string; size: number } | undefined> {
  if (
    row.source_stage_id == null ||
    row.source_attempt == null ||
    row.relative_path == null ||
    row.relative_path.trim() === ""
  ) {
    return undefined;
  }
  const artifactsDir = attemptArtifactsDir(workspaceDir, row.source_stage_id, row.source_attempt);
  try {
    const realPath = await resolveContainedRelativePath(
      artifactsDir,
      row.relative_path,
      PATH_MESSAGES,
    );
    const info = await stat(realPath);
    if (!info.isFile()) return undefined;
    return { realPath, size: info.size };
  } catch {
    return undefined;
  }
}

export async function expireSlimmedIndexed(
  db: Database.Database,
  workspaceDir: string,
  runId: string,
  maxBytes: number,
  now: string,
): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT a.key, a.source_stage_id, a.source_attempt, v.relative_path
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
       WHERE a.origin = 'indexed'
         AND a.source_run_id = ?
         AND a.status = 'available'
         AND a.deleted_at IS NULL`,
    )
    .all(runId) as IndexedFileRow[];
  const dropped: string[] = [];
  for (const row of rows) {
    const file = await containedFile(workspaceDir, row);
    if (file !== undefined && file.size > maxBytes) dropped.push(row.key);
  }
  expireKeys(db, dropped, "run_slimmed", now);
  return dropped;
}

function clearExpiredKeys(db: Database.Database, keys: readonly string[]): void {
  const chunkSize = 80;
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const slice = keys.slice(offset, offset + chunkSize);
    const params: Record<string, string> = {};
    slice.forEach((key, index) => {
      params[`k${index}`] = key;
    });
    const names = slice.map((_, index) => `@k${index}`).join(", ");
    db.prepare(
      `UPDATE artifacts
       SET status = 'available',
           expired_at = NULL,
           expired_reason = NULL
       WHERE key IN (${names})
         AND origin = 'indexed'
         AND status = 'expired'
         AND expired_reason = 'run_slimmed'
         AND deleted_at IS NULL`,
    ).run(params);
  }
}

/** After a failed slim, put back rows from this attempt whose files are still on disk. */
export async function restorePresentSlimmedIndexed(
  db: Database.Database,
  workspaceDir: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  const lookup = db.prepare(
    `SELECT a.key, a.kind, a.source_stage_id, a.source_attempt, v.relative_path
     FROM artifacts a
     LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
     WHERE a.key = ?
       AND a.status = 'expired'
       AND a.expired_reason = 'run_slimmed'
       AND a.deleted_at IS NULL`,
  );
  const present: Array<IndexedFileRow & { kind: string }> = [];
  for (const key of keys) {
    const row = lookup.get(key) as (IndexedFileRow & { kind: string }) | undefined;
    if (row === undefined) continue;
    const file = await containedFile(workspaceDir, row);
    if (file !== undefined) present.push(row);
  }
  const bodies = new Map<string, string>();
  for (const row of present) {
    if (!artifactSearchBodyKind(row.kind) || row.relative_path == null) continue;
    try {
      const absolute = await resolveContainedRelativePath(
        attemptArtifactsDir(workspaceDir, row.source_stage_id ?? "", row.source_attempt ?? 0),
        row.relative_path,
        PATH_MESSAGES,
      );
      bodies.set(row.key, extractSearchBody(row.kind, await readBoundedSearchFile(absolute)));
    } catch (error) {
      logArtifactIndexFailure(`artifact search body ${row.key}`, error);
    }
  }
  db.transaction(() => {
    clearExpiredKeys(db, present.map((row) => row.key));
    for (const row of present) reindexArtifactSearchKey(db, row.key, bodies.get(row.key) ?? "");
  })();
}

type RepairRow = IndexedFileRow & {
  source_run_id: string;
  joined_run_id: string | null;
};

function selectRepairBatch(
  db: Database.Database,
  afterKey: string,
  limit: number,
): RepairRow[] {
  return db
    .prepare(
      `SELECT a.key, a.source_run_id, a.source_stage_id, a.source_attempt, v.relative_path,
              r.run_id AS joined_run_id
       FROM artifacts a
       LEFT JOIN runs r ON r.run_id = a.source_run_id
       LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
       WHERE a.origin = 'indexed'
         AND a.status = 'available'
         AND a.deleted_at IS NULL
         AND (r.run_id IS NULL OR r.status IN ('succeeded', 'failed', 'cancelled'))
         AND a.key > ?
       ORDER BY a.key ASC
       LIMIT ?`,
    )
    .all(afterKey, limit) as RepairRow[];
}

/**
 * Inspect up to `limit` available indexed rows, resuming after `afterKey`.
 * Returns the key to resume after. An empty string starts from the first key.
 * A short page wraps the next call to the start. Limit <= 0 leaves the cursor alone.
 */
export async function repairMissingIndexed(
  db: Database.Database,
  workspaceDirForRun: (runId: string) => string,
  now: string,
  limit: number = INDEXED_ARTIFACT_REPAIR_BATCH,
  afterKey = "",
): Promise<string> {
  try {
    recoverRefreshingArtifacts(db, "sweep");
  } catch (error) {
    logArtifactIndexFailure("artifact refresh recovery", error);
  }
  if (limit <= 0) return afterKey;
  let rows = selectRepairBatch(db, afterKey, limit);
  if (rows.length === 0 && afterKey !== "") {
    rows = selectRepairBatch(db, "", limit);
  }
  const missing: string[] = [];
  const runGone: string[] = [];
  for (const row of rows) {
    if (row.joined_run_id == null) {
      runGone.push(row.key);
      continue;
    }
    let workspaceDir: string;
    try {
      workspaceDir = workspaceDirForRun(row.source_run_id);
    } catch (error) {
      console.error(
        `artifact retention: repair skipped ${row.source_run_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const file = await containedFile(workspaceDir, row);
    if (file === undefined) missing.push(row.key);
  }
  expireKeys(db, missing, "file_missing", now);
  expireKeys(db, runGone, "run_deleted", now);
  try {
    await repairDirtyArtifactSearch(db, workspaceDirForRun);
  } catch (error) {
    logArtifactIndexFailure("artifact search repair", error);
  }
  if (rows.length === 0 || rows.length < limit) return "";
  return rows[rows.length - 1]!.key;
}
