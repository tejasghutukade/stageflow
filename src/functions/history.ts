import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { scrubSecrets } from "../compaction/scrub.js";

export const FUNCTION_INVOCATION_KINDS = ["test", "verification", "route", "tool"] as const;
export type FunctionInvocationKind = (typeof FUNCTION_INVOCATION_KINDS)[number];

export const FUNCTION_INVOCATION_STATUSES = ["succeeded", "failed", "uncertain"] as const;
export type FunctionInvocationStatus = (typeof FUNCTION_INVOCATION_STATUSES)[number];

const DIAGNOSTIC_CODES = new Set([
  "syntax",
  "invalid_input",
  "invalid_output",
  "invalid_export",
  "exception",
  "timeout",
  "cancelled",
  "resource_limit",
  "permission_denied",
  "missing_binding",
  "missing_fixture",
  "uncertain_outcome",
  "source_limit",
  "input_limit",
  "output_limit",
  "memory",
  "stack",
  "killed",
  "not_found",
  "file_limit",
  "job_limit",
  "duplicate",
]);

export type FunctionInvocationDraft = {
  projectKey: string;
  functionId: string;
  revision: number | null;
  sourceHash: string;
  kind: FunctionInvocationKind;
  status: FunctionInvocationStatus;
  durationMs: number;
  code?: string | null;
  detail?: string;
  body?: string;
  requestUrl?: string;
  attachmentId?: string | null;
  runId?: string | null;
  stageId?: string | null;
  attempt?: number | null;
  sessionId?: string | null;
};

export type FunctionInvocationView = {
  id: string;
  functionId: string;
  revision: number | null;
  sourceHash: string;
  kind: FunctionInvocationKind;
  status: FunctionInvocationStatus;
  durationMs: number;
  code: string | null;
  attachmentId: string | null;
  runId: string | null;
  stageId: string | null;
  attempt: number | null;
  sessionId: string | null;
  createdAt: string;
};

type Row = Record<string, unknown>;

export function diagnosticCode(code: string | null | undefined): string | null {
  if (typeof code !== "string" || code.length === 0) return null;
  if (scrubSecrets(code) !== code || !DIAGNOSTIC_CODES.has(code)) return "exception";
  return code;
}

export function recordFunctionInvocation(db: Database.Database, draft: FunctionInvocationDraft): FunctionInvocationView {
  const row: FunctionInvocationView = {
    id: randomUUID(),
    functionId: draft.functionId,
    revision: draft.revision,
    sourceHash: draft.sourceHash,
    kind: draft.kind,
    status: draft.status,
    durationMs: Math.max(0, Math.round(draft.durationMs)),
    code: diagnosticCode(draft.code),
    attachmentId: draft.attachmentId ?? null,
    runId: draft.runId ?? null,
    stageId: draft.stageId ?? null,
    attempt: draft.attempt ?? null,
    sessionId: draft.sessionId ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO function_invocations (
       id, project_key, function_id, revision, source_hash, kind, status, duration_ms, code,
       attachment_id, run_id, stage_id, attempt, session_id, created_at
     ) VALUES (
       @id, @project_key, @function_id, @revision, @source_hash, @kind, @status, @duration_ms, @code,
       @attachment_id, @run_id, @stage_id, @attempt, @session_id, @created_at
     )`,
  ).run({
    id: row.id,
    project_key: draft.projectKey,
    function_id: row.functionId,
    revision: row.revision,
    source_hash: row.sourceHash,
    kind: row.kind,
    status: row.status,
    duration_ms: row.durationMs,
    code: row.code,
    attachment_id: row.attachmentId,
    run_id: row.runId,
    stage_id: row.stageId,
    attempt: row.attempt,
    session_id: row.sessionId,
    created_at: row.createdAt,
  });
  return row;
}

export function listFunctionInvocations(
  db: Database.Database,
  projectKey: string,
  functionId: string,
): FunctionInvocationView[] {
  const rows = db
    .prepare(
      `SELECT id, function_id, revision, source_hash, kind, status, duration_ms, code,
              attachment_id, run_id, stage_id, attempt, session_id, created_at
         FROM function_invocations
        WHERE project_key = ? AND function_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(projectKey, functionId) as Row[];
  return rows.map(toView);
}

function toView(row: Row): FunctionInvocationView {
  return {
    id: String(row.id),
    functionId: String(row.function_id),
    revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
    sourceHash: String(row.source_hash),
    kind: String(row.kind) as FunctionInvocationKind,
    status: String(row.status) as FunctionInvocationStatus,
    durationMs: Number(row.duration_ms),
    code: row.code === null || row.code === undefined ? null : String(row.code),
    attachmentId: row.attachment_id === null || row.attachment_id === undefined ? null : String(row.attachment_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    stageId: row.stage_id === null || row.stage_id === undefined ? null : String(row.stage_id),
    attempt: row.attempt === null || row.attempt === undefined ? null : Number(row.attempt),
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    createdAt: String(row.created_at),
  };
}
