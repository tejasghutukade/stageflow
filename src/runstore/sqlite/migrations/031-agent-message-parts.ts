import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Structured ui parts on an agent message, kept beside the text. */
export const MIGRATION_031 = {
  version: 31,
  name: "031_agent_message_parts",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`ALTER TABLE agent_messages ADD COLUMN parts_json TEXT;`);
  },
};
