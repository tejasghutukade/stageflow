import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Links a rolled channel session to the session it continued, so cost spans the thread. */
export const MIGRATION_019 = {
  version: 19,
  name: "019_agent_session_rollover",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN rolled_from_session_id TEXT;`);
  },
};
