import type Database from "better-sqlite3";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { originApprovalView } from "./originApproval.js";
import { isLiveHtmlKind } from "./kinds.js";
import {
  artifactRecord,
  type ArtifactRecord,
  type ArtifactRow,
  type ArtifactStatus,
} from "./record.js";
import { assertArtifactId, parseOwnerKey, type ParsedOwner } from "./keys.js";
import { ARTIFACT_TAG_PATTERN } from "./limits.js";
import { canonicalProjectWireId } from "./projectScope.js";
import { artifactScopePredicate, EVAL_SESSION_ARTIFACT_EXCLUSION } from "./scopeSql.js";
import {
  ARTIFACT_SEARCH_BM25,
  artifactFtsReady,
  artifactSearchQueryFailsForTests,
  artifactSearchTerms,
  ftsMatchExpression,
  noteArtifactFtsQueryFailed,
} from "./search.js";

const SELECT_COLS = `
  a.key, a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent, a.project_root_id,
  a.id, a.title, a.description, a.tags_json, a.summary, a.kind, a.origin, a.current_version,
  a.source_run_id, a.source_stage_id, a.source_attempt, a.source_session_id, a.hidden, a.scope,
  a.expires_at, a.status, a.expired_at, a.expired_reason, a.created_at, a.updated_at, a.deleted_at,
  a.live_status, a.last_refreshed_at, a.last_error_code,
  v.content_type, v.size_bytes, v.manifest_json
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
  q?: string;
  /** `project` (default) hides session artifacts. `session` lists only those. */
  scope?: "project" | "session";
};

export type ArtifactListPage = {
  artifacts: ArtifactRecord[];
  next_cursor: string | null;
  match_count?: number;
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
  | { mode: "guide" }
  | { mode: "substring"; value: string };

function parseOwnerFilter(owner: string): OwnerFilter {
  if (owner === "guide") return { mode: "guide" };
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

export function parseArtifactScope(raw: string | null): "project" | "session" | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (raw === "project" || raw === "session") return raw;
  invalidFilter("scope must be project or session");
}

export function parseArtifactStatus(raw: string | null): ArtifactStatus | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (raw === "available" || raw === "expired") return raw;
  invalidFilter("status must be available or expired");
}

export function parseArtifactTextQuery(raw: string | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 500) invalidFilter("query is too long");
  if (ftsMatchExpression(trimmed) === null) invalidFilter("query has no searchable terms");
  return trimmed;
}

type SearchCursor = {
  mode: "search";
  q: string;
  offset: number;
  project: string | null;
  status: string | null;
  kind: string | null;
  owner: string | null;
  tag: string | null;
  live: boolean | null;
  scope: "project" | "session";
};

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.mode !== "search") return undefined;
    if (typeof obj.q !== "string" || obj.q.length === 0) return undefined;
    if (typeof obj.offset !== "number" || !Number.isInteger(obj.offset) || obj.offset < 0) return undefined;
    const project = obj.project === null || typeof obj.project === "string" ? (obj.project as string | null) : undefined;
    const status = obj.status === null || obj.status === "available" || obj.status === "expired" ? obj.status : undefined;
    const kind = obj.kind === null || typeof obj.kind === "string" ? (obj.kind as string | null) : undefined;
    const owner = obj.owner === null || typeof obj.owner === "string" ? (obj.owner as string | null) : undefined;
    const tag = obj.tag === null || typeof obj.tag === "string" ? (obj.tag as string | null) : undefined;
    const live = obj.live === null || typeof obj.live === "boolean" ? obj.live : undefined;
    const scope = obj.scope === undefined || obj.scope === "project" || obj.scope === "session" ? (obj.scope === "session" ? "session" : "project") : undefined;
    if (project === undefined || status === undefined || kind === undefined || owner === undefined || tag === undefined || live === undefined || scope === undefined) {
      return undefined;
    }
    return { mode: "search", q: obj.q, offset: obj.offset, project, status, kind, owner, tag, live, scope };
  } catch {
    return undefined;
  }
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

function toRecord(db: Database.Database, row: ArtifactRow, registered: Set<string>): ArtifactRecord {
  const record = artifactRecord(row, registered.has(row.project_root_id));
  if (record.live && isLiveHtmlKind(row.kind)) {
    record.live = { ...record.live, origins: originApprovalView(db, row.key, record.live.csp) };
  }
  return record;
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

function listArtifactsBySearch(
  db: Database.Database,
  query: ArtifactListQuery,
  roots: readonly CatalogRoot[],
  projectId: string | undefined,
  textQuery: string,
): ArtifactListPage {
  const match = ftsMatchExpression(textQuery);
  if (match === null) invalidFilter("query has no searchable terms");
  let kindPattern: string | null = null;
  if (query.kind !== undefined) {
    const literal = escapeLike(query.kind);
    kindPattern = query.kind.includes(".") ? literal : `${literal}.%`;
  }
  const ownerFilter = query.owner !== undefined ? parseOwnerFilter(query.owner) : undefined;
  const live = query.live === true ? true : query.live === false ? false : null;
  const cursor = query.cursor !== undefined ? decodeSearchCursor(query.cursor) : undefined;
  if (query.cursor !== undefined && cursor === undefined) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "cursor is not valid");
  }
  const fingerprint = {
    q: textQuery,
    project: projectId ?? null,
    status: query.status ?? null,
    kind: query.kind ?? null,
    owner: query.owner ?? null,
    tag: query.tag ?? null,
    live,
    scope: query.scope ?? "project",
  };
  if (
    cursor !== undefined &&
    (cursor.q !== fingerprint.q ||
      cursor.project !== fingerprint.project ||
      cursor.status !== fingerprint.status ||
      cursor.kind !== fingerprint.kind ||
      cursor.owner !== fingerprint.owner ||
      cursor.tag !== fingerprint.tag ||
      cursor.live !== fingerprint.live ||
      cursor.scope !== fingerprint.scope)
  ) {
    invalidFilter("cursor does not match query");
  }
  const offset = cursor?.offset ?? 0;
  const whereParts = [
    "a.deleted_at IS NULL",
    "a.hidden = 0",
    "(@project IS NULL OR a.project_root_id = @project)",
    "(@status IS NULL OR a.status = @status)",
    "(@kind_pattern IS NULL OR a.kind LIKE @kind_pattern ESCAPE '\\')",
    "(@live IS NULL OR (@live = 1 AND a.kind LIKE 'live.%') OR (@live = 0 AND a.kind NOT LIKE 'live.%'))",
    "(@tag IS NULL OR EXISTS (SELECT 1 FROM json_each(a.tags_json) je WHERE je.value = @tag))",
    artifactScopePredicate(query.scope),
    EVAL_SESSION_ARTIFACT_EXCLUSION,
  ];
  if (ownerFilter?.mode === "stage") {
    whereParts.push(
      "a.owner_kind = 'stage' AND a.owner_pipeline = @owner_pipeline AND a.owner_stage = @owner_stage",
    );
  } else if (ownerFilter?.mode === "agent") {
    whereParts.push("a.owner_kind = 'agent' AND a.owner_agent = @owner_agent");
  } else if (ownerFilter?.mode === "guide") {
    whereParts.push("a.owner_kind = 'guide'");
  } else if (ownerFilter?.mode === "substring") {
    whereParts.push(
      `instr(lower(trim(coalesce(a.owner_pipeline, '') || ' ' || coalesce(a.owner_stage, '') || ' ' || coalesce(a.owner_agent, '') || CASE WHEN a.owner_kind = 'guide' THEN ' guide' ELSE '' END)), @owner_sub) > 0`,
    );
  }
  const params: Record<string, string | number | null> = {
    project: projectId ?? null,
    status: query.status ?? null,
    kind_pattern: kindPattern,
    live: live === null ? null : live ? 1 : 0,
    tag: query.tag ?? null,
    owner_pipeline: ownerFilter?.mode === "stage" ? ownerFilter.pipeline : null,
    owner_stage: ownerFilter?.mode === "stage" ? ownerFilter.stage : null,
    owner_agent: ownerFilter?.mode === "agent" ? ownerFilter.agent : null,
    owner_sub: ownerFilter?.mode === "substring" ? ownerFilter.value : null,
  };
  const terms = artifactSearchTerms(textQuery);
  terms.forEach((term, index) => {
    params[`like_${index}`] = `%${escapeLike(term.toLowerCase())}%`;
  });
  const likeSql = terms
    .map(
      (_, index) => `(
         lower(a.title) LIKE @like_${index} ESCAPE '\\'
         OR lower(COALESCE(a.description, '')) LIKE @like_${index} ESCAPE '\\'
         OR lower(a.tags_json) LIKE @like_${index} ESCAPE '\\'
         OR lower(COALESCE(a.summary, '')) LIKE @like_${index} ESCAPE '\\'
         OR lower(a.id) LIKE @like_${index} ESCAPE '\\'
         OR lower(
           CASE a.owner_kind
             WHEN 'agent' THEN 'agent:' || COALESCE(a.owner_agent, '') || ' ' || COALESCE(a.owner_agent, '')
             WHEN 'guide' THEN 'guide'
             ELSE 'stage:' || COALESCE(a.owner_pipeline, '') || ':' || COALESCE(a.owner_stage, '')
               || ' ' || COALESCE(a.owner_pipeline, '') || ' ' || COALESCE(a.owner_stage, '')
           END
         ) LIKE @like_${index} ESCAPE '\\'
       )`,
    )
    .join("\n         AND ");

  const runLike = (): ArtifactListPage => {
    const sqlWhere = `${whereParts.join("\n         AND ")}\n         AND ${likeSql}`;
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${sqlWhere}`)
      .get(params) as { n: number };
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} ${FROM}
         WHERE ${sqlWhere}
         ORDER BY a.updated_at DESC, a.key ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit + 1, offset }) as ArtifactRow[];
    return pageFromRows(db, rows, roots, query.limit, offset, fingerprint, total.n);
  };

  if (artifactFtsReady(db)) {
    try {
      if (artifactSearchQueryFailsForTests()) throw new Error("injected fts query failure");
      const ftsParams = { ...params, match, limit: query.limit + 1, offset };
      const sharedWhere = whereParts.join("\n         AND ");
      const ranked = `
        SELECT a.key AS hit_key, ${ARTIFACT_SEARCH_BM25} AS search_rank
        FROM artifacts a
        JOIN artifact_fts ON artifact_fts.key = a.key
        WHERE ${sharedWhere}
          AND artifact_fts MATCH @match
        UNION ALL
        SELECT a.key AS hit_key, 1000000000000000000 AS search_rank
        FROM artifacts a
        WHERE ${sharedWhere}
          AND a.status = 'expired'
          AND ${likeSql}
          AND NOT EXISTS (SELECT 1 FROM artifact_fts f WHERE f.key = a.key)
      `;
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM (${ranked}) hits`)
        .get(ftsParams) as { n: number };
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLS}, hits.search_rank AS search_rank
           FROM (${ranked}) hits
           JOIN artifacts a ON a.key = hits.hit_key
           LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
           ORDER BY hits.search_rank ASC, a.key ASC
           LIMIT @limit OFFSET @offset`,
        )
        .all(ftsParams) as ArtifactRow[];
      return pageFromRows(db, rows, roots, query.limit, offset, fingerprint, total.n);
    } catch (error) {
      noteArtifactFtsQueryFailed(error);
    }
  }
  return runLike();
}

function pageFromRows(
  db: Database.Database,
  rows: ArtifactRow[],
  roots: readonly CatalogRoot[],
  limit: number,
  offset: number,
  fingerprint: Omit<SearchCursor, "mode" | "offset">,
  matchCount: number,
): ArtifactListPage {
  const page = rows.slice(0, limit);
  const registered = registeredIds(roots);
  const nextOffset = offset + page.length;
  return {
    artifacts: page.map((row) => toRecord(db, row, registered)),
    next_cursor:
      rows.length > limit
        ? encodeSearchCursor({ mode: "search", ...fingerprint, offset: nextOffset })
        : null,
    match_count: matchCount,
  };
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
  const textQuery = query.q?.trim() ?? "";
  if (textQuery.length > 0) {
    return listArtifactsBySearch(db, query, roots, projectId, textQuery);
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
    artifactScopePredicate(query.scope),
    EVAL_SESSION_ARTIFACT_EXCLUSION,
    cursorPredicate(sort, order),
  ];
  if (ownerFilter?.mode === "stage") {
    whereParts.push(
      "a.owner_kind = 'stage' AND a.owner_pipeline = @owner_pipeline AND a.owner_stage = @owner_stage",
    );
  } else if (ownerFilter?.mode === "agent") {
    whereParts.push("a.owner_kind = 'agent' AND a.owner_agent = @owner_agent");
  } else if (ownerFilter?.mode === "guide") {
    whereParts.push("a.owner_kind = 'guide'");
  } else if (ownerFilter?.mode === "substring") {
    whereParts.push(
      `instr(lower(trim(coalesce(a.owner_pipeline, '') || ' ' || coalesce(a.owner_stage, '') || ' ' || coalesce(a.owner_agent, '') || CASE WHEN a.owner_kind = 'guide' THEN ' guide' ELSE '' END)), @owner_sub) > 0`,
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
    artifacts: page.map((row) => toRecord(db, row, registered)),
    next_cursor: extra
      ? encodeArtifactCursor(sort, order, sortPrimaryValue(extra, sort), extra.key)
      : null,
  };
}

function ownerClause(owner: ParsedOwner): { sql: string; params: Record<string, string> } {
  if (owner.kind === "guide") return { sql: `a.owner_kind = 'guide'`, params: {} };
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
         AND ${EVAL_SESSION_ARTIFACT_EXCLUSION}
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
  return toRecord(db, rows[0]!, registered);
}
