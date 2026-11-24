import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Regular FTS5 table (it stores a copy of the text), not contentless.
 * `key` is UNINDEXED so a row can be deleted and replaced by `key` inside the
 * same transaction as the artifact write. Contentless FTS5 can only address
 * rows by integer rowid. `prefix` indexes 2- and 3-character prefixes.
 * `remove_diacritics 2` folds marks for every script, not only Latin.
 * If FTS5 cannot be created, the migration still commits and records
 * `artifact_search_meta.fts = unavailable`.
 */
export const ARTIFACT_FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title,
  description,
  tags,
  summary,
  owner,
  body,
  project_root_id UNINDEXED,
  key UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
)`;

let createFtsForTests: ((db: Database.Database) => void) | undefined;

export function setArtifactFtsCreateForTests(fn?: (db: Database.Database) => void): void {
  createFtsForTests = fn;
}

function createFts(db: Database.Database): void {
  if (createFtsForTests) {
    createFtsForTests(db);
    return;
  }
  db.exec(ARTIFACT_FTS_SQL);
}

export const MIGRATION_027 = {
  version: 27,
  name: "027_artifact_search",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_search_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_search_dirty (
        key TEXT PRIMARY KEY
      );
    `);
    let available = false;
    try {
      createFts(db);
      available = true;
    } catch (error) {
      console.error(
        `artifact search: FTS5 unavailable, search will use a text scan: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    db.prepare(
      `INSERT INTO artifact_search_meta (key, value) VALUES ('fts', @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ value: available ? "available" : "unavailable" });
    if (!available) return;
    const backfill = db
      .prepare(`SELECT value FROM artifact_search_meta WHERE key = 'backfill'`)
      .get() as { value: string } | undefined;
    if (backfill?.value === "done") return;
    db.exec(`
      INSERT INTO artifact_fts (title, description, tags, summary, owner, body, project_root_id, key)
      SELECT
        a.title,
        COALESCE(a.description, ''),
        COALESCE(a.tags_json, ''),
        COALESCE(a.summary, ''),
        CASE a.owner_kind
          WHEN 'agent' THEN 'agent:' || COALESCE(a.owner_agent, '') || ' ' || COALESCE(a.owner_agent, '')
          ELSE 'stage:' || COALESCE(a.owner_pipeline, '') || ':' || COALESCE(a.owner_stage, '')
            || ' ' || COALESCE(a.owner_pipeline, '') || ' ' || COALESCE(a.owner_stage, '')
        END,
        '',
        a.project_root_id,
        a.key
      FROM artifacts a
      WHERE a.hidden = 0
        AND a.deleted_at IS NULL
        AND (a.status IS NULL OR a.status = 'available');
      INSERT OR IGNORE INTO artifact_search_dirty (key)
      SELECT a.key
      FROM artifacts a
      WHERE a.hidden = 0
        AND a.deleted_at IS NULL
        AND (a.status IS NULL OR a.status = 'available');
    `);
    db.prepare(
      `INSERT INTO artifact_search_meta (key, value) VALUES ('backfill', 'done')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
  },
};
