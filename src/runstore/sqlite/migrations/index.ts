import type Database from "better-sqlite3";
import { MIGRATION_001 } from "./001-baseline.js";

export const CURRENT_SCHEMA_VERSION = MIGRATION_001.version;

export type SqliteMigration = {
  version: number;
  name: string;
  minStageflowVersion: string;
  up: (db: Database.Database) => void;
};

const DEFAULT_MIGRATIONS: SqliteMigration[] = [MIGRATION_001];

export type SchemaMigrationRow = {
  version: number;
  name: string;
  applied_at: string;
  min_stageflow_version: string;
};

export function readSchemaMigrationRow(
  db: Database.Database,
  version: number,
): SchemaMigrationRow | undefined {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get() as { name: string } | undefined;
  if (!table) return undefined;
  return db
    .prepare(
      `SELECT version, name, applied_at, min_stageflow_version FROM schema_migrations WHERE version = ?`,
    )
    .get(version) as SchemaMigrationRow | undefined;
}

export function applyPendingMigrations(
  db: Database.Database,
  options?: { migrations?: SqliteMigration[] },
): void {
  const migrations = options?.migrations ?? DEFAULT_MIGRATIONS;
  let version = db.pragma("user_version", { simple: true }) as number;
  const maxKnown = migrations[migrations.length - 1]?.version ?? 0;
  if (version > maxKnown) {
    const row = readSchemaMigrationRow(db, version);
    const minVersion = row?.min_stageflow_version ?? "unknown";
    throw new Error(
      `store_schema_too_new: on_disk=${version} binary_max=${maxKnown} min_stageflow=${minVersion}`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) {
      throw new Error(
        `Missing migration between schema version ${version} and ${migration.version}`,
      );
    }
    db.transaction(() => {
      migration.up(db);
      const appliedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO schema_migrations (version, name, applied_at, min_stageflow_version)
         VALUES (@version, @name, @applied_at, @min_stageflow_version)`,
      ).run({
        version: migration.version,
        name: migration.name,
        applied_at: appliedAt,
        min_stageflow_version: migration.minStageflowVersion,
      });
      db.pragma(`user_version = ${migration.version}`);
    })();
    version = migration.version;
  }
}
