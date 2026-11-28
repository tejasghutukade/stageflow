import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

export const MIGRATION_025 = {
  version: 25,
  name: "025_reserved_search",
  minStageflowVersion: PACKAGE_VERSION,
  up(_db: Database.Database): void {},
};
