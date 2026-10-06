import type { Logger } from "./logger.js";
import type { CallerSurface } from "../server/requestAuthContext.js";

export type AuditOutcome = "ok" | "error";

export type AuditRecord = {
  caller_id: string | null;
  surface: CallerSurface;
  action: string;
  target_run_id?: string;
  outcome: AuditOutcome;
  error_code?: string;
};

/**
 * Append-only mutating-call audit on the Slot 4 JSON logger.
 * Allowlisted fields only — never Authorization, pipeline_body, or skills.
 */
export function writeAudit(log: Logger, record: AuditRecord): void {
  const fields: Record<string, unknown> = {
    caller_id: record.caller_id,
    surface: record.surface,
    action: record.action,
    outcome: record.outcome,
  };
  if (record.target_run_id !== undefined) {
    fields.target_run_id = record.target_run_id;
  }
  if (record.error_code !== undefined) {
    fields.error_code = record.error_code;
  }
  log.info("audit", `${record.action} ${record.outcome}`, fields);
}
