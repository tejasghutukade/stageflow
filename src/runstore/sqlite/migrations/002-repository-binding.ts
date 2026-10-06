import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

const BINDING_COLUMNS = [
  "repository",
  "ref",
  "resolved_sha",
  "run_branch",
  "git_author_name",
  "git_author_email",
] as const;

function addColumn(db: Database.Database, name: (typeof BINDING_COLUMNS)[number]): void {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_002 = {
  version: 2,
  name: "002_repository_binding",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    for (const name of BINDING_COLUMNS) {
      addColumn(db, name);
    }
  },
};
