import type Database from "better-sqlite3";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import {
  artifactRecord,
  type ArtifactRecord,
  type ArtifactRow,
  type ArtifactStatus,
} from "./record.js";
import { assertArtifactId, parseOwnerKey, type ParsedOwner } from "./keys.js";
import { ARTIFACT_TAG_PATTERN } from "./limits.js";
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

export const ARTIFACT_LIST_SORTS = ["updated", "title", "size"] as const;
export type ArtifactListSort = (typeof ARTIFACT_LIST_SORTS)[number];

export const ARTIFACT_LIST_ORDERS = ["asc", "desc"] as const;
export type ArtifactListOrder = (typeof ARTIFACT_LIST_ORDERS)[number];

export type ArtifactListQuery = {
  projectRoot?: string;
  limit: number;
  cursor?: string;
  status?: ArtifactStatus;
  kind?: string;
  owner?: string;
  tag?: string;
  live?: boolean;
  sort?: ArtifactListSort;
  order?: ArtifactListOrder;
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

export type ArtifactListCursor = {
  sort: ArtifactListSort;
  order: ArtifactListOrder;
  primary: string | number;
  key: string;
};

export function encodeArtifactCursor(
  sort: ArtifactListSort,
  order: ArtifactListOrder,
  primary: string | number,
  key: string,
): string {
  return Buffer.from(JSON.stringify({ sort, order, primary, key }), "utf8").toString("base64url");
}

function isListSort(value: string): value is ArtifactListSort {
  return (ARTIFACT_LIST_SORTS as readonly string[]).includes(value);
}

function isListOrder(value: string): value is ArtifactListOrder {
  return (ARTIFACT_LIST_ORDERS as readonly string[]).includes(value);
}

function cursorFromFields(sort: string, order: string, primary: unknown, key: unknown): ArtifactListCursor | undefined {
  if (!isListSort(sort) || !isListOrder(order) || typeof key !== "string" || key.length === 0) return undefined;
  if (sort === "size") {
    if (typeof primary !== "number" || !Number.isSafeInteger(primary)) return undefined;
    return { sort, order, primary, key };
  }
  if (typeof primary !== "string") return undefined;
  return { sort, order, primary, key };
}

function decodeLegacyCursor(raw: string): ArtifactListCursor | undefined {
  const parts = raw.split("\n");
  if (parts.length === 4 && parts[0] && parts[1] && parts[2] && parts[3]) {
    const sort = parts[0];
    const order = parts[1];
    if (!isListSort(sort) || !isListOrder(order)) return undefined;
    if (sort === "size") {
      if (!/^-?\d+$/.test(parts[2])) return undefined;
      const primary = Number(parts[2]);
      if (!Number.isSafeInteger(primary)) return undefined;
      return { sort, order, primary, key: parts[3] };
    }
    return { sort, order, primary: parts[2], key: parts[3] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { sort: "updated", order: "desc", primary: parts[0], key: parts[1] };
  }
  return undefined;
}

export function decodeArtifactCursor(cursor: string): ArtifactListCursor | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const obj = parsed as Record<string, unknown>;
      if (Object.keys(obj).length !== 4) return undefined;
      if (typeof obj.sort !== "string" || typeof obj.order !== "string") return undefined;
      return cursorFromFields(obj.sort, obj.order, obj.primary, obj.key);
    }
    return decodeLegacyCursor(raw);
  } catch {
    return undefined;
  }
}

function invalidFilter(message: string): never {
  throw new ArtifactQueryError(400, "artifact.invalid_filter", message);
}

export function parseArtifactListSort(raw: string | null): ArtifactListSort | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if ((ARTIFACT_LIST_SORTS as readonly string[]).includes(raw)) return raw as ArtifactListSort;
  invalidFilter("sort must be updated, title, or size");
}

export function parseArtifactListOrder(raw: string | null): ArtifactListOrder | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if ((ARTIFACT_LIST_ORDERS as readonly string[]).includes(raw)) return raw as ArtifactListOrder;
  invalidFilter("order must be asc or desc");
}

export function parseArtifactKindFilter(raw: string | null): string | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const kind = raw.trim();
  if (kind.length > 64) invalidFilter("kind filter is too long");
  if (!/^[a-z][a-z0-9_.-]*$/i.test(kind)) invalidFilter("kind filter is not valid");
  return kind.toLowerCase();
}

export function parseArtifactOwnerFilter(raw: string | null): string | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const owner = raw.trim();
  if (owner.length > 200) invalidFilter("owner filter is too long");
  return owner;
}

export function parseArtifactTagFilter(raw: string | null): string | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const tag = raw.trim().toLowerCase();
  if (tag !== raw.trim()) invalidFilter("tag must be lowercase");
  if (!ARTIFACT_TAG_PATTERN.test(tag)) invalidFilter("tag is not a valid slug");
  return tag;
}

export function parseArtifactLiveFilter(raw: string | null): boolean | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  invalidFilter("live must be true or false");
}

type OwnerFilter =
  | { mode: "stage"; pipeline: string; stage: string }
  | { mode: "agent"; agent: string }
  | { mode: "substring"; value: string };

function parseOwnerFilter(owner: string): OwnerFilter {
  if (owner.startsWith("stage:")) {
    const parts = owner.slice("stage:".length).split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { mode: "stage", pipeline: parts[0], stage: parts[1] };
    }
  }
  if (owner.startsWith("agent:")) {
    const agent = owner.slice("agent:".length);
    if (agent.length > 0) return { mode: "agent", agent };
  }
  return { mode: "substring", value: owner.toLowerCase() };
}

export function parseArtifactStatus(raw: string | null): ArtifactStatus | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (raw === "available" || raw === "expired") return raw;
  invalidFilter("status must be available or expired");
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

function sortPrimaryExpr(sort: ArtifactListSort): string {
  if (sort === "updated") return "a.updated_at";
  if (sort === "title") return "a.title COLLATE NOCASE";
  return "COALESCE(v.size_bytes, -1)";
}

function sortPrimaryValue(row: ArtifactRow, sort: ArtifactListSort): string | number {
  if (sort === "updated") return row.updated_at;
  if (sort === "title") return row.title;
  return row.size_bytes ?? -1;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function cursorCompareExpr(sort: ArtifactListSort): { column: string; bound: string } {
  if (sort === "title") {
    return { column: "a.title COLLATE NOCASE", bound: "@cursor_primary COLLATE NOCASE" };
  }
  const column = sortPrimaryExpr(sort);
  return { column, bound: "@cursor_primary" };
}

function cursorPredicate(sort: ArtifactListSort, order: ArtifactListOrder): string {
  const { column, bound } = cursorCompareExpr(sort);
  const direction = order === "desc" ? "<" : ">";
  return `(
           @cursor_primary IS NULL
           OR ${column} ${direction} ${bound}
           OR (${column} = ${bound} AND a.key > @cursor_key)
         )`;
}

function orderByClause(sort: ArtifactListSort, order: ArtifactListOrder): string {
  const dir = order === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${sortPrimaryExpr(sort)} ${dir}, a.key ASC`;
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
  const sort = query.sort ?? "updated";
  const order = query.order ?? (sort === "title" ? "asc" : "desc");
  const cursorDecoded = query.cursor !== undefined ? decodeArtifactCursor(query.cursor) : undefined;
  if (query.cursor !== undefined && cursorDecoded === undefined) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "cursor is not valid");
  }
  if (cursorDecoded !== undefined && (cursorDecoded.sort !== sort || cursorDecoded.order !== order)) {
    invalidFilter("cursor does not match sort or order");
  }

  let kindPattern: string | null = null;
  if (query.kind !== undefined) {
    const literal = escapeLike(query.kind);
    kindPattern = query.kind.includes(".") ? literal : `${literal}.%`;
  }
  let ownerFilter: OwnerFilter | undefined;
  if (query.owner !== undefined) {
    ownerFilter = parseOwnerFilter(query.owner);
  }

  const whereParts = [
    "a.deleted_at IS NULL",
    "a.hidden = 0",
    "(@project IS NULL OR a.project_root_id = @project)",
    "(@status IS NULL OR a.status = @status)",
    "(@kind_pattern IS NULL OR a.kind LIKE @kind_pattern ESCAPE '\\')",
    "(@live IS NULL OR (@live = 1 AND a.kind LIKE 'live.%') OR (@live = 0 AND a.kind NOT LIKE 'live.%'))",
    "(@tag IS NULL OR EXISTS (SELECT 1 FROM json_each(a.tags_json) je WHERE je.value = @tag))",
    cursorPredicate(sort, order),
  ];
  if (ownerFilter?.mode === "stage") {
    whereParts.push(
      "a.owner_kind = 'stage' AND a.owner_pipeline = @owner_pipeline AND a.owner_stage = @owner_stage",
    );
  } else if (ownerFilter?.mode === "agent") {
    whereParts.push("a.owner_kind = 'agent' AND a.owner_agent = @owner_agent");
  } else if (ownerFilter?.mode === "substring") {
    whereParts.push(
      `instr(lower(trim(coalesce(a.owner_pipeline, '') || ' ' || coalesce(a.owner_stage, '') || ' ' || coalesce(a.owner_agent, ''))), @owner_sub) > 0`,
    );
  }

  const sql = `SELECT ${SELECT_COLS} ${FROM}
       WHERE ${whereParts.join("\n         AND ")}
       ${orderByClause(sort, order)}
       LIMIT @limit`;

  const rows = db
    .prepare(sql)
    .all({
      project: projectId ?? null,
      status: query.status ?? null,
      kind_pattern: kindPattern,
      live: query.live === true ? 1 : query.live === false ? 0 : null,
      tag: query.tag ?? null,
      owner_mode: ownerFilter?.mode === "stage" || ownerFilter?.mode === "agent" ? ownerFilter.mode : null,
      owner_pipeline: ownerFilter?.mode === "stage" ? ownerFilter.pipeline : null,
      owner_stage: ownerFilter?.mode === "stage" ? ownerFilter.stage : null,
      owner_agent: ownerFilter?.mode === "agent" ? ownerFilter.agent : null,
      owner_sub: ownerFilter?.mode === "substring" ? ownerFilter.value : null,
      cursor_primary: cursorDecoded?.primary ?? null,
      cursor_key: cursorDecoded?.key ?? null,
      limit: query.limit + 1,
    }) as ArtifactRow[];
  const page = rows.slice(0, query.limit);
  const registered = registeredIds(roots);
  const extra = rows.length > query.limit ? page[page.length - 1] : undefined;
  return {
    artifacts: page.map((row) => toRecord(row, registered)),
    next_cursor: extra
      ? encodeArtifactCursor(sort, order, sortPrimaryValue(extra, sort), extra.key)
      : null,
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
