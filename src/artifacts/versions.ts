import type Database from "better-sqlite3";
import { removeStoredVersion } from "./store.js";

export type ArtifactVersionInfo = {
  version: number;
  size_bytes: number | null;
  content_hash: string | null;
  created_at: string;
  pinned: boolean;
  current: boolean;
  kind: string | null;
};

export type ArtifactVersionRow = {
  version: number;
  storage: string | null;
  relative_path: string | null;
  content_hash: string | null;
  content_type: string | null;
  size_bytes: number | null;
  manifest_json: string | null;
  source_run_id: string | null;
  source_stage_id: string | null;
  source_attempt: number | null;
};

let pruneFailure: (() => void) | undefined;

export function setPruneFailureForTests(fn?: () => void): void {
  pruneFailure = fn;
}

export function artifactVersionKind(manifestJson: string | null | undefined): string | null {
  if (!manifestJson) return null;
  try {
    const parsed = JSON.parse(manifestJson) as { kind?: unknown };
    return typeof parsed.kind === "string" && parsed.kind.length > 0 ? parsed.kind : null;
  } catch {
    return null;
  }
}

export function listArtifactVersions(
  db: Database.Database,
  storageKey: string,
  currentVersion: number,
): ArtifactVersionInfo[] {
  const rows = db
    .prepare(
      `SELECT version, size_bytes, content_hash, created_at, pinned, manifest_json
       FROM artifact_versions
       WHERE key = ?
       ORDER BY version DESC`,
    )
    .all(storageKey) as Array<{
    version: number;
    size_bytes: number | null;
    content_hash: string | null;
    created_at: string;
    pinned: number;
    manifest_json: string | null;
  }>;
  return rows.map((row) => ({
    version: row.version,
    size_bytes: row.size_bytes,
    content_hash: row.content_hash,
    created_at: row.created_at,
    pinned: row.pinned === 1,
    current: row.version === currentVersion,
    kind: artifactVersionKind(row.manifest_json),
  }));
}

export function readArtifactVersionRow(
  db: Database.Database,
  storageKey: string,
  version: number,
): ArtifactVersionRow | undefined {
  return db
    .prepare(
      `SELECT version, storage, relative_path, content_hash, content_type, size_bytes, manifest_json,
              source_run_id, source_stage_id, source_attempt
       FROM artifact_versions
       WHERE key = ? AND version = ?`,
    )
    .get(storageKey, version) as ArtifactVersionRow | undefined;
}

export async function pruneArtifactVersions(
  db: Database.Database,
  storageKey: string,
  currentVersion: number,
  keep: number,
): Promise<void> {
  if (pruneFailure) {
    const fail = pruneFailure;
    pruneFailure = undefined;
    fail();
  }
  const rows = db
    .prepare(
      `SELECT version, pinned, storage FROM artifact_versions WHERE key = ? ORDER BY version DESC`,
    )
    .all(storageKey) as Array<{ version: number; pinned: number; storage: string | null }>;
  const keepSet = new Set<number>();
  for (const row of rows.slice(0, keep)) keepSet.add(row.version);
  for (const row of rows) {
    if (row.pinned === 1) keepSet.add(row.version);
  }
  keepSet.add(currentVersion);
  for (const row of rows) {
    if (keepSet.has(row.version) || row.version === currentVersion) continue;
    db.prepare(`DELETE FROM artifact_versions WHERE key = ? AND version = ?`).run(storageKey, row.version);
    if (row.storage === "store") {
      try {
        await removeStoredVersion(storageKey, row.version);
      } catch (error) {
        console.error(
          `artifact publish: failed to remove pruned version ${storageKey} v${row.version}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
