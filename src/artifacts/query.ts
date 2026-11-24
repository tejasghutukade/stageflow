import type Database from "better-sqlite3";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import {
  artifactRecord,
  type ArtifactRecord,
  type ArtifactRow,
  type ArtifactStatus,
} from "./record.js";
import { assertArtifactId, parseOwnerKey, type ParsedOwner } from "./keys.js";
import { canonicalProjectWireId } from "./projectScope.js";

const SELECT_COLS = `
  a.key, a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent, a.project_root_id,
  a.id, a.title, a.description, a.tags_json, a.summary, a.kind, a.origin, a.current_version,
  a.source_run_id, a.source_stage_id, a.source_attempt, a.source_session_id, a.hidden,
  a.expires_at, a.status, a.expired_at, a.expired_reason, a.created_at, a.updated_at, a.deleted_at,
  v.content_type, v.size_bytes
`;

const FROM = `
  FROM artifacts a
  LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
`;

export type ArtifactListQuery = {
  projectRoot?: string;
  limit: number;
  cursor?: string;
  status?: ArtifactStatus;
};

export type ArtifactListPage = {
  artifacts: ArtifactRecord[];
  next_cursor: string | null;
};

export class ArtifactQueryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly projectRoots?: string[],
  ) {
    super(message);
    this.name = "ArtifactQueryError";
  }
}

export function encodeArtifactCursor(updatedAt: string, key: string): string {
  return Buffer.from(`${updatedAt}\n${key}`, "utf8").toString("base64url");
}

export function decodeArtifactCursor(cursor: string): { updatedAt: string; key: string } | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const nl = raw.indexOf("\n");
    if (nl <= 0 || nl === raw.length - 1) return undefined;
    return { updatedAt: raw.slice(0, nl), key: raw.slice(nl + 1) };
  } catch {
    return undefined;
  }
}

export function parseArtifactStatus(raw: string | null): ArtifactStatus | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (raw === "available" || raw === "expired") return raw;
  throw new ArtifactQueryError(400, "artifact.invalid_shape", "status must be available or expired");
}

export function parseArtifactLimit(raw: string | null): number {
  if (raw == null || raw.trim() === "") return 50;
  if (!/^\d+$/.test(raw)) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "limit must be an integer from 1 to 100");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 100) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "limit must be an integer from 1 to 100");
  }
  return limit;
}

function registeredIds(roots: readonly CatalogRoot[]): Set<string> {
  return new Set(roots.map((root) => root.project_root));
}

function toRecord(row: ArtifactRow, registered: Set<string>): ArtifactRecord {
  return artifactRecord(row, registered.has(row.project_root_id));
}

export function listArtifacts(
  db: Database.Database,
  query: ArtifactListQuery,
  roots: readonly CatalogRoot[],
): ArtifactListPage {
  const projectId =
    query.projectRoot !== undefined && query.projectRoot.trim().length > 0
      ? canonicalProjectWireId(query.projectRoot, roots).id
      : undefined;
  if (projectId?.includes("::")) {
    throw new ArtifactQueryError(400, "artifact.invalid_id", `Project id must not contain "::"`);
  }
  const cursor = query.cursor !== undefined ? decodeArtifactCursor(query.cursor) : undefined;
  if (query.cursor !== undefined && cursor === undefined) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "cursor is not valid");
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} ${FROM}
       WHERE a.deleted_at IS NULL AND a.hidden = 0
         AND (@project IS NULL OR a.project_root_id = @project)
         AND (@status IS NULL OR a.status = @status)
         AND (
           @cursor_at IS NULL
           OR a.updated_at < @cursor_at
           OR (a.updated_at = @cursor_at AND a.key > @cursor_key)
         )
       ORDER BY a.updated_at DESC, a.key ASC
       LIMIT @limit`,
    )
    .all({
      project: projectId ?? null,
      status: query.status ?? null,
      cursor_at: cursor?.updatedAt ?? null,
      cursor_key: cursor?.key ?? null,
      limit: query.limit + 1,
    }) as ArtifactRow[];
  const page = rows.slice(0, query.limit);
  const registered = registeredIds(roots);
  const extra = rows.length > query.limit ? page[page.length - 1] : undefined;
  return {
    artifacts: page.map((row) => toRecord(row, registered)),
    next_cursor: extra ? encodeArtifactCursor(extra.updated_at, extra.key) : null,
  };
}

function ownerClause(owner: ParsedOwner): { sql: string; params: Record<string, string> } {
  if (owner.kind === "agent") {
    return {
      sql: `a.owner_kind = 'agent' AND a.owner_agent = @agent`,
      params: { agent: owner.agent },
    };
  }
  return {
    sql: `a.owner_kind = 'stage' AND a.owner_pipeline = @pipeline AND a.owner_stage = @stage`,
    params: { pipeline: owner.pipeline, stage: owner.stage },
  };
}

export function readArtifact(
  db: Database.Database,
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
  roots: readonly CatalogRoot[],
): ArtifactRecord {
  if (ownerKey.includes("::") || id.includes("::")) {
    throw new ArtifactQueryError(400, "artifact.invalid_id", `Id must not contain "::"`);
  }
  const owner = parseOwnerKey(ownerKey);
  if (owner === undefined) {
    throw new ArtifactQueryError(400, "artifact.invalid_id", "Owner key is not valid");
  }
  try {
    assertArtifactId(id);
  } catch (error) {
    throw new ArtifactQueryError(
      400,
      "artifact.invalid_id",
      error instanceof Error ? error.message : "Artifact id is not valid",
    );
  }
  const projectId =
    projectRoot !== undefined && projectRoot.trim().length > 0
      ? canonicalProjectWireId(projectRoot, roots).id
      : undefined;
  if (projectId?.includes("::")) {
    throw new ArtifactQueryError(400, "artifact.invalid_id", `Project id must not contain "::"`);
  }
  const ownerSql = ownerClause(owner);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} ${FROM}
       WHERE a.deleted_at IS NULL AND a.hidden = 0 AND a.id = @id AND ${ownerSql.sql}
         AND (@project IS NULL OR a.project_root_id = @project)
       ORDER BY a.project_root_id ASC`,
    )
    .all({
      id,
      ...ownerSql.params,
      project: projectId ?? null,
    }) as ArtifactRow[];
  if (rows.length === 0) {
    throw new ArtifactQueryError(404, "artifact.not_found", "Artifact not found");
  }
  if (projectId === undefined && new Set(rows.map((row) => row.project_root_id)).size > 1) {
    throw new ArtifactQueryError(
      409,
      "artifact.ambiguous",
      "Artifact owner and id exist in more than one project; pass project_root",
      [...new Set(rows.map((row) => row.project_root_id))].sort(),
    );
  }
  const registered = registeredIds(roots);
  return toRecord(rows[0]!, registered);
}
