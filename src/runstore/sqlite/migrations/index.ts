import type Database from "better-sqlite3";
import { StoreSchemaError } from "../storeSchemaError.js";
import { MIGRATION_001 } from "./001-baseline.js";
import { MIGRATION_002 } from "./002-repository-binding.js";
import { MIGRATION_003 } from "./003-run-lifecycle.js";

export type SqliteMigration = {
  version: number;
  name: string;
  minStageflowVersion: string;
  up: (db: Database.Database) => void;
};

const DEFAULT_MIGRATIONS: SqliteMigration[] = [
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
];

export const CURRENT_SCHEMA_VERSION =
  DEFAULT_MIGRATIONS[DEFAULT_MIGRATIONS.length - 1]!.version;

export type SchemaMigrationRow = {
  version: number;
  name: string;
  applied_at: string;
  min_stageflow_version: string;
};

function throwStoreSchemaTooNew(
  db: Database.Database,
  version: number,
  maxKnown: number,
): never {
  const row = readSchemaMigrationRow(db, version);
  const minVersion = row?.min_stageflow_version ?? "unknown";
  throw new StoreSchemaError(
    `store_schema_too_new: on_disk=${version} binary_max=${maxKnown} min_stageflow=${minVersion}`,
    "store_schema_too_new",
  );
}

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

export function assertSchemaVersion(
  db: Database.Database,
  options?: { migrations?: SqliteMigration[] },
): void {
  const migrations = options?.migrations ?? DEFAULT_MIGRATIONS;
  const version = db.pragma("user_version", { simple: true }) as number;
  const maxKnown = migrations[migrations.length - 1]?.version ?? 0;
  if (version > maxKnown) {
    throwStoreSchemaTooNew(db, version, maxKnown);
  }
  if (version < maxKnown) {
    throw new StoreSchemaError(
      `store_schema_migration_required: on_disk=${version} binary_max=${maxKnown}`,
      "store_schema_migration_required",
    );
  }
}

export function applyPendingMigrations(
  db: Database.Database,
  options?: { migrations?: SqliteMigration[] },
): void {
  const migrations = options?.migrations ?? DEFAULT_MIGRATIONS;
  let version = db.pragma("user_version", { simple: true }) as number;
  const maxKnown = migrations[migrations.length - 1]?.version ?? 0;
  if (version > maxKnown) {
    throwStoreSchemaTooNew(db, version, maxKnown);
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
