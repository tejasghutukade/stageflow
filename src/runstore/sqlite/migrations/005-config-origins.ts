import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

function addColumn(db: Database.Database): void {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN config_origins_json TEXT`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_005 = {
  version: 5,
  name: "005_config_origins",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    addColumn(db);
  },
};
