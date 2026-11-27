import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { ownerKeyFromRow } from "./owners.js";
import type { ArtifactOwner } from "./record.js";
import { ArtifactPublishError, type ArtifactIssue } from "./limits.js";
import { STATIC_CONTENT_MAX_BYTES } from "./limits.js";
import { publishArtifact } from "./publish.js";

/**
 * Shared in-session publish adapter. Stages and agents call this with an
 * owner and a source. Provenance is written in the same transaction as the
 * version, inside `publishArtifact`.
 *
 * Ticket 12 (agents) should call `publishSessionArtifact` with
 * `owner: { kind: "agent", agent }` and `source.sessionId`. Do not open
 * `state.db` from a stage worker; use `workerPublishArtifact` there.
 */
export type SessionPublishSource = {
  runId?: string;
  stageId?: string;
  attempt?: number;
  sessionId?: string | null;
};

export type SessionPublishContext = {
  owner: ArtifactOwner;
  projectRoot?: string;
  source: SessionPublishSource;
};

export type SessionPublishBody = {
  id: string;
  kind: string;
  title: string;
  description?: string | null;
  tags?: string[];
  summary?: string | null;
  bytes: Buffer;
  manifest?: unknown;
};

export type SessionPublishSuccess = {
  key: string;
  version: number;
  unchanged?: boolean;
  url?: string;
  project_root: string;
  warnings?: ArtifactIssue[];
};

export class SessionPublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: ArtifactIssue[],
  ) {
    super(message);
    this.name = "SessionPublishError";
  }
}

const WORKER_TIMEOUT_MS = 65_000;
/** Base64 of the content cap, plus a small allowance for the other IPC fields. */
export const WORKER_PUBLISH_BASE64_MAX_CHARS = Math.ceil(STATIC_CONTENT_MAX_BYTES / 3) * 4;
const WORKER_PUBLISH_IPC_OVERHEAD_CHARS = 64 * 1024;

function sessionPublishHidden(db: Database.Database, context: SessionPublishContext): boolean {
  const runId = context.source.runId;
  if (runId !== undefined) {
    try {
      const row = db.prepare(`SELECT origin FROM runs WHERE run_id = ?`).get(runId) as
        | { origin: string | null }
        | undefined;
      if (row?.origin === "eval") return true;
    } catch {
      return true;
    }
  }
  const sessionId = context.source.sessionId;
  if (sessionId) {
    try {
      const row = db.prepare(`SELECT source FROM agent_sessions WHERE session_id = ?`).get(sessionId) as
        | { source: string }
        | undefined;
      if (row?.source === "eval") return true;
    } catch {
      return true;
    }
  }
  return false;
}

type WorkerTransport = {
  connected?: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message" | "disconnect", listener: (message?: unknown) => void): unknown;
  once(event: "disconnect", listener: () => void): unknown;
};

export function publishSessionArtifact(
  deps: { db: Database.Database; roots: readonly CatalogRoot[] },
  context: SessionPublishContext,
  body: SessionPublishBody,
): Promise<SessionPublishSuccess> {
  const hidden = sessionPublishHidden(deps.db, context);
  return publishArtifact(deps.db, {
    owner: context.owner,
    ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
    id: body.id,
    kind: body.kind,
    title: body.title,
    description: body.description,
    tags: body.tags,
    summary: body.summary,
    bytes: body.bytes,
    ...(body.manifest !== undefined ? { manifest: body.manifest } : {}),
    publishSource: "api",
    source: {
      kind: context.owner.kind,
      ...(context.source.runId !== undefined ? { runId: context.source.runId } : {}),
      ...(context.source.stageId !== undefined ? { stageId: context.source.stageId } : {}),
      ...(context.source.attempt !== undefined ? { attempt: context.source.attempt } : {}),
      ...(context.source.sessionId !== undefined ? { sessionId: context.source.sessionId } : {}),
    },
    ...(hidden ? { hidden: true, ownerNamespace: "eval" as const } : {}),
    roots: deps.roots,
  }).then((result) => ({
    key: result.key,
    version: result.version,
    ...(result.unchanged ? { unchanged: true } : {}),
    url: result.url,
    project_root: result.project_root,
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  }));
}

function attemptIdForRun(
  db: Database.Database,
  source: { runId: string; stageId: string; attempt: number },
  stored: string,
): string | undefined {
  const run = db.prepare(`SELECT project_root, pipeline_id FROM runs WHERE run_id = ?`).get(source.runId) as
    | { project_root: string | null; pipeline_id: string }
    | undefined;
  if (stored.includes("::")) {
    const id = stored.slice(stored.lastIndexOf("/") + 1);
    if (!run?.project_root || !run.pipeline_id) return id;
    const visible = `${run.project_root}::stage:${run.pipeline_id}:${source.stageId}/${id}`;
    const evalKey = `${run.project_root}::eval:stage:${run.pipeline_id}:${source.stageId}/${id}`;
    return stored === visible || stored === evalKey ? id : undefined;
  }
  if (!run?.project_root || !run.pipeline_id) return undefined;
  const visible = `${run.project_root}::stage:${run.pipeline_id}:${source.stageId}/${stored}`;
  const evalKey = `${run.project_root}::eval:stage:${run.pipeline_id}:${source.stageId}/${stored}`;
  const hit = db.prepare(`SELECT 1 AS ok FROM artifacts WHERE key = ? OR key = ?`).get(visible, evalKey) as
    | { ok: number }
    | undefined;
  return hit ? stored : undefined;
}

export function listPublishedIdsForAttempt(
  db: Database.Database,
  source: { runId: string; stageId: string; attempt: number },
): string[] {
  const rows = db
    .prepare(
      `SELECT artifact_key FROM artifact_attempt_publishes
       WHERE run_id = ? AND stage_id = ? AND attempt = ?
       ORDER BY artifact_key`,
    )
    .all(source.runId, source.stageId, source.attempt) as Array<{ artifact_key: string }>;
  const ids: string[] = [];
  for (const row of rows) {
    const id = attemptIdForRun(db, source, row.artifact_key);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export type PublishedArtifactSummary = {
  key: string;
  version: number;
  kind: string;
  title: string;
};

function publishedKind(manifestJson: string | null, fallback: string): string {
  if (manifestJson === null) return fallback;
  try {
    const parsed = JSON.parse(manifestJson) as { kind?: unknown };
    if (typeof parsed.kind === "string" && parsed.kind.length > 0) return parsed.kind;
  } catch {
    return fallback;
  }
  return fallback;
}

export function publishedArtifactsForRun(
  db: Database.Database,
  runId: string,
): Map<string, PublishedArtifactSummary[]> {
  const rows = db
    .prepare(
      `SELECT owner_kind, owner_pipeline, owner_stage, owner_agent, id, title, kind, version, stage_id, manifest_json, storage_key
       FROM (
         SELECT a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent, a.id, a.title, a.kind,
                v.version AS version, v.source_stage_id AS stage_id, v.manifest_json AS manifest_json,
                a.key AS storage_key
         FROM artifact_versions v
         JOIN artifacts a ON a.key = v.key
         WHERE v.source_run_id = @run
           AND v.source_stage_id IS NOT NULL
           AND a.deleted_at IS NULL
           AND a.hidden = 0
         UNION
         SELECT a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent, a.id, a.title, a.kind,
                p.version AS version, p.stage_id AS stage_id, v.manifest_json AS manifest_json,
                a.key AS storage_key
         FROM artifact_attempt_publishes p
         JOIN artifacts a ON a.deleted_at IS NULL AND (
           a.key = p.artifact_key
           OR (
             instr(p.artifact_key, '::') = 0
             AND a.id = p.artifact_key
             AND a.owner_stage = p.stage_id
             AND EXISTS (
               SELECT 1 FROM runs r
               WHERE r.run_id = p.run_id
                 AND r.project_root = a.project_root_id
                 AND r.pipeline_id = a.owner_pipeline
             )
           )
         )
         JOIN artifact_versions v ON v.key = a.key AND v.version = p.version
         WHERE p.run_id = @run
           AND p.stage_id = a.owner_stage
       ) AS published
       ORDER BY stage_id, id, version`,
    )
    .all({ run: runId }) as Array<{
    owner_kind: string;
    owner_pipeline: string | null;
    owner_stage: string | null;
    owner_agent: string | null;
    id: string;
    title: string;
    kind: string;
    version: number;
    stage_id: string;
    manifest_json: string | null;
    storage_key: string;
  }>;
  const grouped = new Map<string, PublishedArtifactSummary[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const stored = row.storage_key.includes("::")
      ? row.storage_key.slice(row.storage_key.indexOf("::") + 2)
      : `${ownerKeyFromRow(row)}/${row.id}`;
    const item: PublishedArtifactSummary = {
      key: stored,
      version: row.version,
      kind: publishedKind(row.manifest_json, row.kind),
      title: row.title,
    };
    const dedupe = `${row.stage_id}\0${item.key}\0${item.version}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const list = grouped.get(row.stage_id);
    if (list) list.push(item);
    else grouped.set(row.stage_id, [item]);
  }
  return grouped;
}

export function assertWorkerPublishInput(input: unknown): void {
  if (input === null || typeof input !== "object") {
    throw new SessionPublishError("artifact.invalid_shape", "artifact publish input is missing", [
      { path: "input", message: "artifact publish input is missing" },
    ]);
  }
  const record = input as Record<string, unknown>;
  let extra = 0;
  for (const [key, value] of Object.entries(record)) {
    if (key === "content_base64") continue;
    if (typeof value === "string") extra += value.length;
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") extra += item.length;
    }
  }
  const encoded = record.content_base64;
  const encodedLength = typeof encoded === "string" ? encoded.length : 0;
  if (
    encodedLength > WORKER_PUBLISH_BASE64_MAX_CHARS ||
    encodedLength + extra > WORKER_PUBLISH_BASE64_MAX_CHARS + WORKER_PUBLISH_IPC_OVERHEAD_CHARS
  ) {
    throw new SessionPublishError(
      "artifact.too_large",
      `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
      [{ path: "content", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
    );
  }
}

export function artifactWorkerFault(error: unknown): {
  code: string;
  message: string;
  issues?: ArtifactIssue[];
} {
  if (error instanceof ArtifactPublishError || error instanceof SessionPublishError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues !== undefined ? { issues: error.issues } : {}),
    };
  }
  return { code: "artifact.invalid_shape", message: "artifact publish failed" };
}

export type ArtifactWorkerPublishInput = {
  id: string;
  kind: string;
  title: string;
  description?: string | null;
  tags?: string[];
  summary?: string | null;
  content_base64: string;
  manifest?: unknown;
};

export function isArtifactWorkerMessage(
  message: unknown,
): message is { type: string; requestId?: unknown; input?: unknown } {
  if (message === null || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return type === "artifact.publish" || type === "artifact.expect";
}

function workerTransport(): WorkerTransport | undefined {
  const candidate = process as unknown as WorkerTransport;
  if (candidate.connected !== true || typeof candidate.send !== "function") return undefined;
  return candidate;
}

function workerCall<T>(
  type: "artifact.publish" | "artifact.expect",
  input: unknown,
  read: (response: {
    result?: SessionPublishSuccess;
    ids?: string[];
    error?: { code: string; message: string; issues?: ArtifactIssue[] };
  }) => T,
): Promise<T> {
  const transport = workerTransport();
  if (!transport) {
    return Promise.reject(new SessionPublishError("artifact.invalid_shape", "artifact publish is not available"));
  }
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error?: SessionPublishError, value?: T): void => {
      clearTimeout(timer);
      transport.off("message", receive);
      transport.off("disconnect", disconnected);
      if (error) reject(error);
      else resolve(value as T);
    };
    const disconnected = (): void => {
      finish(new SessionPublishError("artifact.invalid_shape", "artifact publish is not available"));
    };
    const receive = (message: unknown): void => {
      const response = message as {
        type?: string;
        requestId?: string;
        result?: SessionPublishSuccess;
        ids?: string[];
        error?: { code: string; message: string; issues?: ArtifactIssue[] };
      };
      if (response?.type !== "artifact.response" || response.requestId !== requestId) return;
      if (response.error) {
        finish(new SessionPublishError(response.error.code, response.error.message, response.error.issues));
        return;
      }
      try {
        finish(undefined, read(response));
      } catch (error) {
        finish(error instanceof SessionPublishError ? error : new SessionPublishError("artifact.invalid_shape", "artifact publish failed"));
      }
    };
    const timer = setTimeout(disconnected, WORKER_TIMEOUT_MS);
    transport.on("message", receive);
    transport.once("disconnect", disconnected);
    transport.send({ type, requestId, ...(input !== undefined ? { input } : {}) }, (error) => {
      if (error) disconnected();
    });
  });
}

export function workerPublishArtifact(body: SessionPublishBody): Promise<SessionPublishSuccess> {
  const input: ArtifactWorkerPublishInput = {
    id: body.id,
    kind: body.kind,
    title: body.title,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.summary !== undefined ? { summary: body.summary } : {}),
    ...(body.manifest !== undefined ? { manifest: body.manifest } : {}),
    content_base64: body.bytes.toString("base64"),
  };
  return workerCall("artifact.publish", input, (response) => {
    if (!response.result || typeof response.result.key !== "string" || typeof response.result.version !== "number") {
      throw new SessionPublishError("artifact.invalid_shape", "artifact publish failed");
    }
    return response.result;
  });
}

export function workerPublishedIds(): Promise<string[]> {
  return workerCall("artifact.expect", undefined, (response) => {
    if (!Array.isArray(response.ids) || response.ids.some((id) => typeof id !== "string")) {
      throw new SessionPublishError("artifact.invalid_shape", "published artifacts cannot be verified");
    }
    return response.ids;
  });
}

export function decodeWorkerPublishBytes(contentBase64: unknown): Buffer {
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new SessionPublishError("artifact.invalid_shape", "content_base64 is not valid base64", [
      { path: "content_base64", message: "must be standard base64 with no whitespace" },
    ]);
  }
  if (contentBase64.length > WORKER_PUBLISH_BASE64_MAX_CHARS) {
    throw new SessionPublishError(
      "artifact.too_large",
      `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
      [{ path: "content", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
    );
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > STATIC_CONTENT_MAX_BYTES) {
    throw new SessionPublishError(
      "artifact.too_large",
      `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
      [{ path: "content", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
    );
  }
  return bytes;
}
