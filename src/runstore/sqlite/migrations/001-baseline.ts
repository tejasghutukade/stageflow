import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";
import { applyBaselineSchema } from "../schema.js";

export const MIGRATION_001 = {
  version: 1,
  name: "001_baseline",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    applyBaselineSchema(db);
  },
};
