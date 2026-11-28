import type Database from "better-sqlite3";
import { applyPendingMigrations, STORE_MIGRATIONS } from "../../src/runstore/sqlite/migrations/index.js";

/** Apply the store migrations up to `version`, inclusive, on an empty database. */
export function applySchemaThrough(db: Database.Database, version: number): void {
  applyPendingMigrations(db, {
    migrations: STORE_MIGRATIONS.filter((migration) => migration.version <= version),
  });
}
