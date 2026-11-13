import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Routing decision for one stage attempt. Written with the success envelope
 * and replayed by the scheduler. Not a fork_choice.
 */
export const MIGRATION_022 = {
  version: 22,
  name: "022_function_route",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    const cols = db.prepare(`PRAGMA table_info(stage_executions)`).all() as { name: string }[];
    if (cols.some((col) => col.name === "function_route_json")) return;
    db.exec(`ALTER TABLE stage_executions ADD COLUMN function_route_json TEXT`);
  },
};
