import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Agent eval results point at an agent session, not a stage run: `subject_ref` is the root subject id
 * (stage run id for stage results, agent session id for agent results). `turns` and `tool_call_count`
 * are agent summaries. Additive; stage rows keep `stage_run_id` and are backfilled.
 */
export const MIGRATION_016 = {
  version: 16,
  name: "016_eval_subject_ref",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
ALTER TABLE eval_results ADD COLUMN subject_ref TEXT;
ALTER TABLE eval_results ADD COLUMN turns INTEGER;
ALTER TABLE eval_results ADD COLUMN tool_call_count INTEGER;
UPDATE eval_results SET subject_ref = stage_run_id WHERE stage_run_id IS NOT NULL;
CREATE INDEX eval_results_subject_ref ON eval_results (subject_ref);
`);
  },
};
