import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { scrubSecrets } from "../compaction/scrub.js";

export const FUNCTION_INVOCATION_KINDS = ["test", "verification", "route", "tool", "artifact"] as const;
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

export const FUNCTION_INVOCATION_LIST_DEFAULT = 200;
export const FUNCTION_INVOCATION_LIST_MAX = 1_000;
export const FUNCTION_HISTORY_DAYS_ENV = "STAGEFLOW_FUNCTION_HISTORY_DAYS";
export const FUNCTION_HISTORY_MAX_ROWS_ENV = "STAGEFLOW_FUNCTION_HISTORY_MAX_ROWS";
export const DEFAULT_FUNCTION_HISTORY_DAYS = 30;
export const DEFAULT_FUNCTION_HISTORY_MAX_ROWS = 50_000;
export const FUNCTION_HISTORY_PRUNE_BATCH = 5_000;
export const FUNCTION_HISTORY_DAYS_MAX = 3_650;
export const FUNCTION_HISTORY_MAX_ROWS_CAP = 1_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  limit: number = FUNCTION_INVOCATION_LIST_DEFAULT,
): FunctionInvocationView[] {
  const rows = db
    .prepare(
      `SELECT id, function_id, revision, source_hash, kind, status, duration_ms, code,
              attachment_id, run_id, stage_id, attempt, session_id, created_at
         FROM function_invocations
        WHERE project_key = ? AND function_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(projectKey, functionId, boundInvocationLimit(limit)) as Row[];
  return rows.map(toView);
}

export function functionHistoryLimits(env: NodeJS.ProcessEnv = process.env): { days: number; maxRows: number } {
  return {
    days: readPositiveInt(env, FUNCTION_HISTORY_DAYS_ENV, DEFAULT_FUNCTION_HISTORY_DAYS, FUNCTION_HISTORY_DAYS_MAX),
    maxRows: readPositiveInt(env, FUNCTION_HISTORY_MAX_ROWS_ENV, DEFAULT_FUNCTION_HISTORY_MAX_ROWS, FUNCTION_HISTORY_MAX_ROWS_CAP),
  };
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  if (text.length > 10 || !/^\d+$/.test(text)) {
    throw new Error(`${key} must be an integer from 1 to ${max}`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${key} must be an integer from 1 to ${max}`);
  }
  return value;
}

function boundInvocationLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return FUNCTION_INVOCATION_LIST_DEFAULT;
  return Math.min(limit, FUNCTION_INVOCATION_LIST_MAX);
}

export function pruneFunctionInvocations(
  db: Database.Database,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
  batch: number = FUNCTION_HISTORY_PRUNE_BATCH,
): number {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'function_invocations'`).get();
  if (!table) return 0;
  const { days, maxRows } = functionHistoryLimits(env);
  const limit = Math.max(1, Math.min(batch, FUNCTION_HISTORY_PRUNE_BATCH));
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const prune = db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM function_invocations`).get() as { n: number }).n;
    const older = (
      db.prepare(`SELECT COUNT(*) AS n FROM function_invocations WHERE created_at < ?`).get(cutoff) as { n: number }
    ).n;
    const over = Math.max(0, total - maxRows);
    if (older === 0 && over === 0) return 0;
    const deleting = Math.min(limit, older >= over ? older : over);
    if (older >= over) {
      return db
        .prepare(
          `DELETE FROM function_invocations WHERE id IN (
             SELECT id FROM function_invocations
              WHERE created_at < ?
              ORDER BY created_at ASC, id ASC
              LIMIT ?
           )`,
        )
        .run(cutoff, deleting).changes;
    }
    return db
      .prepare(
        `DELETE FROM function_invocations WHERE id IN (
           SELECT id FROM function_invocations
            ORDER BY created_at ASC, id ASC
            LIMIT ?
         )`,
      )
      .run(deleting).changes;
  });
  return prune();
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
