import { open } from "node:fs/promises";
import type Database from "better-sqlite3";
import { PATH_DENIED_MESSAGE, resolveContainedRelativePath } from "../runread/readArtifact.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import { ARTIFACT_FTS_SQL } from "../runstore/sqlite/migrations/027-artifact-search.js";
import { readStoredArtifactFile } from "./store.js";

/** First 64 KiB of UTF-8 text, cut on a code-point boundary. */
export const ARTIFACT_SEARCH_BODY_MAX_BYTES = 64 * 1024;

/** Dirty keys rebuilt per repair call. */
export const ARTIFACT_SEARCH_REPAIR_BATCH = 200;

/** Host-start repair spends at most this long per tick, then continues later. */
export const ARTIFACT_SEARCH_START_BUDGET_MS = 3000;

/**
 * bm25 column weights, in FTS column order:
 * title, description, tags, summary, owner, body.
 * Title and tags outweigh summary and description, which outweigh owner, which outweighs body.
 * A smaller (more negative) bm25 value ranks first.
 */
export const ARTIFACT_SEARCH_BM25 =
  "bm25(artifact_fts, 10.0, 5.0, 10.0, 5.0, 2.0, 1.0)";

const BODY_KINDS = new Set(["static.markdown", "static.text", "static.table"]);
const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const TERM_RE = /\p{L}[\p{L}\p{M}\p{N}_]*|\p{N}[\p{L}\p{M}\p{N}_]*/gu;
const MAX_TERMS = 16;
const MAX_TERM_CHARS = 64;

const FILE_MESSAGES = {
  relativeRequired: "path must be relative to the run workspace",
  escapes: "path escapes the run workspace",
  notFound: (relativePath: string) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

let failWrites = false;
let failQuery = false;
let afterUnindex: (() => void) | undefined;
let loggedIndexFailure = false;
let loggedFtsFallback = false;
let loggedFtsRecreate = false;
let repairCursor = "";
let repairEpoch = 0;
let beforeRepairWrite: (() => Promise<void> | void) | undefined;
let ftsDdl: (db: Database.Database) => void = (db) => {
  db.exec(ARTIFACT_FTS_SQL);
};

export function setArtifactSearchWriteFailureForTests(enabled: boolean): void {
  failWrites = enabled;
}

export function setArtifactSearchQueryFailureForTests(enabled: boolean): void {
  failQuery = enabled;
}

export function setArtifactSearchAfterUnindexForTests(fn?: () => void): void {
  afterUnindex = fn;
}

export function setArtifactSearchDdlForTests(fn?: (db: Database.Database) => void): void {
  ftsDdl = fn ?? ((db) => {
    db.exec(ARTIFACT_FTS_SQL);
  });
}

export function setArtifactSearchBeforeRepairWriteForTests(fn?: () => Promise<void> | void): void {
  beforeRepairWrite = fn;
}

/** Stop the host-start repair loop. Further ticks are not scheduled. Idempotent. */
export function stopArtifactSearchRepair(): void {
  repairEpoch += 1;
}

export function resetArtifactSearchForTests(): void {
  failWrites = false;
  failQuery = false;
  afterUnindex = undefined;
  beforeRepairWrite = undefined;
  loggedIndexFailure = false;
  loggedFtsFallback = false;
  loggedFtsRecreate = false;
  repairCursor = "";
  setArtifactSearchDdlForTests(undefined);
}

export function artifactSearchBodyKind(kind: string): boolean {
  return BODY_KINDS.has(kind);
}

export function artifactSearchTerms(raw: string): string[] {
  const terms: string[] = [];
  for (const match of raw.matchAll(TERM_RE)) {
    const term = match[0] ?? "";
    if (term.length === 0 || OPERATORS.has(term.toUpperCase())) continue;
    terms.push(term.length > MAX_TERM_CHARS ? term.slice(0, MAX_TERM_CHARS) : term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/** Quoted terms AND-ed together. The last term is a prefix. Null when nothing remains. */
export function ftsMatchExpression(raw: string): string | null {
  const terms = artifactSearchTerms(raw);
  if (terms.length === 0) return null;
  return terms
    .map((term, index) => {
      const quoted = `"${term.replaceAll('"', '""')}"`;
      return index === terms.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}

export function extractSearchBody(kind: string, bytes: Buffer): string {
  if (!artifactSearchBodyKind(kind)) return "";
  const slice = capUtf8(bytes, ARTIFACT_SEARCH_BODY_MAX_BYTES);
  return slice.toString("utf8").replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, " ");
}

export function capUtf8(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    let lead = end - 1;
    while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead -= 1;
    const marker = bytes[lead]!;
    let need = 1;
    if ((marker & 0xe0) === 0xc0) need = 2;
    else if ((marker & 0xf0) === 0xe0) need = 3;
    else if ((marker & 0xf8) === 0xf0) need = 4;
    if (lead + need > end) end = lead;
  }
  return bytes.subarray(0, end);
}

export function artifactSearchOwnerText(row: {
  owner_kind: string;
  owner_pipeline: string | null;
  owner_stage: string | null;
  owner_agent: string | null;
}): string {
  if (row.owner_kind === "guide") return "guide";
  if (row.owner_kind === "agent") {
    const agent = row.owner_agent ?? "";
    return `agent:${agent} ${agent}`.trim();
  }
  const pipeline = row.owner_pipeline ?? "";
  const stage = row.owner_stage ?? "";
  return `stage:${pipeline}:${stage} ${pipeline} ${stage}`.trim();
}

export function artifactSearchTagsText(tagsJson: string | null): string {
  if (tagsJson == null || tagsJson.trim() === "") return "";
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((tag): tag is string => typeof tag === "string").join(" ");
    }
  } catch {
    return tagsJson;
  }
  return tagsJson;
}

type SearchRow = {
  key: string;
  title: string;
  description: string | null;
  tags_json: string;
  summary: string | null;
  owner_kind: string;
  owner_pipeline: string | null;
  owner_stage: string | null;
  owner_agent: string | null;
  project_root_id: string;
  kind: string;
  hidden: number;
  status: string | null;
  deleted_at: string | null;
  origin: string;
  current_version: number;
  updated_at: string;
  source_run_id: string | null;
  source_stage_id: string | null;
  source_attempt: number | null;
  relative_path: string | null;
  storage: string | null;
};

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

function ftsMetaValue(db: Database.Database): string | undefined {
  if (!tableExists(db, "artifact_search_meta")) return undefined;
  const meta = db
    .prepare(`SELECT value FROM artifact_search_meta WHERE key = 'fts'`)
    .get() as { value: string } | undefined;
  return meta?.value;
}

function ensureSearchTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_search_dirty (
      key TEXT PRIMARY KEY
    );
  `);
}

function setFtsMeta(db: Database.Database, value: "available" | "unavailable"): void {
  ensureSearchTables(db);
  db.prepare(
    `INSERT INTO artifact_search_meta (key, value) VALUES ('fts', @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run({ value });
}

export function artifactFtsReady(db: Database.Database): boolean {
  if (!tableExists(db, "artifact_fts")) {
    logFtsFallback();
    return false;
  }
  if (ftsMetaValue(db) === "unavailable") {
    logFtsFallback();
    return false;
  }
  return true;
}

/**
 * Recreate a missing or unavailable FTS table with the migration 027 DDL.
 * On success every artifact is marked dirty so the repair pass reindexes titles and bodies.
 * If creation fails, search stays on the text scan and this logs once per process.
 */
export function ensureArtifactSearchIndex(db: Database.Database): boolean {
  const missing = !tableExists(db, "artifact_fts");
  const unavailable = ftsMetaValue(db) === "unavailable";
  if (!missing && !unavailable) return true;
  try {
    ftsDdl(db);
    if (!tableExists(db, "artifact_fts")) {
      throw new Error("artifact_fts was not created");
    }
    setFtsMeta(db, "available");
    if (tableExists(db, "artifacts")) {
      db.exec(`INSERT OR IGNORE INTO artifact_search_dirty (key) SELECT key FROM artifacts`);
    }
    if (!loggedFtsRecreate) {
      loggedFtsRecreate = true;
      console.error("artifact search: full-text index recreated; queued artifacts for reindex");
    }
    return true;
  } catch (error) {
    try {
      setFtsMeta(db, "unavailable");
    } catch (metaError) {
      logIndexFailure(metaError);
    }
    logFtsFallback(error);
    return false;
  }
}

export function artifactSearchPendingCount(db: Database.Database): number {
  if (!tableExists(db, "artifact_search_dirty")) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM artifact_search_dirty`).get() as { n: number };
  return row.n;
}

export function artifactSearchQueryFailsForTests(): boolean {
  return failQuery;
}

function logFtsFallback(error?: unknown): void {
  if (loggedFtsFallback) return;
  loggedFtsFallback = true;
  const detail = error instanceof Error ? `: ${error.message}` : error !== undefined ? `: ${String(error)}` : "";
  console.error(`artifact search: full-text index unavailable, using a text scan${detail}`);
}

export function noteArtifactFtsQueryFailed(error: unknown): void {
  logFtsFallback(error);
}

function logIndexFailure(error: unknown): void {
  if (loggedIndexFailure) return;
  loggedIndexFailure = true;
  console.error(
    `artifact search: index update failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function markDirty(db: Database.Database, key: string): void {
  if (!tableExists(db, "artifact_search_dirty")) return;
  db.prepare(
    `INSERT INTO artifact_search_dirty (key) VALUES (?) ON CONFLICT(key) DO NOTHING`,
  ).run(key);
}

function clearDirty(db: Database.Database, key: string): void {
  if (!tableExists(db, "artifact_search_dirty")) return;
  db.prepare(`DELETE FROM artifact_search_dirty WHERE key = ?`).run(key);
}

function replaceFts(
  db: Database.Database,
  row: {
    key: string;
    title: string;
    description: string;
    tags: string;
    summary: string;
    owner: string;
    body: string;
    projectRootId: string;
  },
): void {
  if (!artifactFtsReady(db)) return;
  if (failWrites) throw new Error("injected search index failure");
  db.prepare(`DELETE FROM artifact_fts WHERE key = ?`).run(row.key);
  db.prepare(
    `INSERT INTO artifact_fts (
       title, description, tags, summary, owner, body, project_root_id, key
     ) VALUES (
       @title, @description, @tags, @summary, @owner, @body, @project_root_id, @key
     )`,
  ).run({
    title: row.title,
    description: row.description,
    tags: row.tags,
    summary: row.summary,
    owner: row.owner,
    body: row.body,
    project_root_id: row.projectRootId,
    key: row.key,
  });
}

export function unindexArtifactSearch(db: Database.Database, key: string): void {
  try {
    if (!tableExists(db, "artifact_fts")) return;
    if (failWrites) throw new Error("injected search index failure");
    db.prepare(`DELETE FROM artifact_fts WHERE key = ?`).run(key);
  } catch (error) {
    logIndexFailure(error);
    markDirty(db, key);
    return;
  }
  clearDirty(db, key);
  afterUnindex?.();
}

export function syncArtifactSearch(
  db: Database.Database,
  row: {
    key: string;
    title: string;
    description: string | null;
    tagsJson: string | null;
    summary: string | null;
    ownerText: string;
    projectRootId: string;
    kind: string;
    body: string;
    hidden: number;
    status: string | null;
    deleted: boolean;
  },
  options?: { bodyIncomplete?: boolean },
): void {
  try {
    if (row.hidden !== 0 || row.deleted) {
      unindexArtifactSearch(db, row.key);
      return;
    }
    replaceFts(db, {
      key: row.key,
      title: row.title,
      description: row.description ?? "",
      tags: artifactSearchTagsText(row.tagsJson),
      summary: row.summary ?? "",
      owner: row.ownerText,
      body: artifactSearchBodyKind(row.kind) ? row.body : "",
      projectRootId: row.projectRootId,
    });
    if (options?.bodyIncomplete) markDirty(db, row.key);
    else clearDirty(db, row.key);
  } catch (error) {
    logIndexFailure(error);
    markDirty(db, row.key);
  }
}

const SEARCH_ROW_SQL = `
  SELECT a.key, a.title, a.description, a.tags_json, a.summary,
         a.owner_kind, a.owner_pipeline, a.owner_stage, a.owner_agent, a.project_root_id,
         a.kind, a.hidden, a.status, a.deleted_at, a.origin, a.current_version, a.updated_at,
         a.source_run_id, a.source_stage_id, a.source_attempt,
         v.relative_path, v.storage
  FROM artifacts a
  LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
  WHERE a.key = ?
`;

function readSearchRow(db: Database.Database, key: string): SearchRow | undefined {
  return db.prepare(SEARCH_ROW_SQL).get(key) as SearchRow | undefined;
}

export function reindexArtifactSearchKey(db: Database.Database, key: string, body = ""): void {
  const row = readSearchRow(db, key);
  if (row === undefined) {
    unindexArtifactSearch(db, key);
    return;
  }
  syncArtifactSearch(db, {
    key: row.key,
    title: row.title,
    description: row.description,
    tagsJson: row.tags_json,
    summary: row.summary,
    ownerText: artifactSearchOwnerText(row),
    projectRootId: row.project_root_id,
    kind: row.kind,
    body,
    hidden: row.hidden,
    status: row.status,
    deleted: row.deleted_at != null,
  });
}

export function hideArtifactFromSearch(db: Database.Database, key: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE artifacts SET hidden = 1 WHERE key = ?`).run(key);
    unindexArtifactSearch(db, key);
  })();
}

export async function readBoundedSearchFile(absolute: string): Promise<Buffer> {
  const handle = await open(absolute, "r");
  try {
    const buf = Buffer.alloc(ARTIFACT_SEARCH_BODY_MAX_BYTES + 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function loadArtifactSearchBody(
  row: SearchRow,
  workspaceDirForRun?: (runId: string) => string,
): Promise<{ body: string; incomplete: boolean }> {
  if (!artifactSearchBodyKind(row.kind)) return { body: "", incomplete: false };
  try {
    if (row.storage === "store" && row.relative_path) {
      const bytes = await readStoredArtifactFile(row.key, row.current_version, row.relative_path);
      return { body: extractSearchBody(row.kind, bytes), incomplete: false };
    }
    if (
      row.origin === "indexed" &&
      workspaceDirForRun &&
      row.source_run_id &&
      row.source_stage_id &&
      row.source_attempt != null &&
      row.relative_path
    ) {
      const dir = attemptArtifactsDir(workspaceDirForRun(row.source_run_id), row.source_stage_id, row.source_attempt);
      const absolute = await resolveContainedRelativePath(dir, row.relative_path, FILE_MESSAGES);
      const bytes = await readBoundedSearchFile(absolute);
      return { body: extractSearchBody(row.kind, bytes), incomplete: false };
    }
  } catch (error) {
    logIndexFailure(error);
    return { body: "", incomplete: true };
  }
  return { body: "", incomplete: false };
}

function nextDirtyKeys(db: Database.Database, limit: number): string[] {
  const after = db
    .prepare(`SELECT key FROM artifact_search_dirty WHERE key > ? ORDER BY key ASC LIMIT ?`)
    .all(repairCursor, limit) as { key: string }[];
  const keys = after.map((row) => row.key);
  if (keys.length < limit) {
    const wrap = db
      .prepare(`SELECT key FROM artifact_search_dirty WHERE key <= ? ORDER BY key ASC LIMIT ?`)
      .all(repairCursor, limit - keys.length) as { key: string }[];
    for (const row of wrap) {
      if (!keys.includes(row.key)) keys.push(row.key);
    }
  }
  if (keys.length > 0) repairCursor = keys[keys.length - 1]!;
  return keys;
}

function deferDirtyKey(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM artifact_search_dirty WHERE key = ?`).run(key);
  db.prepare(`INSERT INTO artifact_search_dirty (key) VALUES (?)`).run(key);
}

export async function repairDirtyArtifactSearch(
  db: Database.Database,
  workspaceDirForRun?: (runId: string) => string,
  limit = ARTIFACT_SEARCH_REPAIR_BATCH,
  stopped?: () => boolean,
): Promise<number> {
  if (stopped?.()) return 0;
  if (limit <= 0 || !tableExists(db, "artifact_search_dirty")) return 0;
  const keys = nextDirtyKeys(db, limit);
  let repaired = 0;
  for (const key of keys) {
    if (stopped?.()) break;
    const row = readSearchRow(db, key);
    let body = "";
    let incomplete = false;
    if (row !== undefined && row.hidden === 0 && row.deleted_at == null) {
      const loaded = await loadArtifactSearchBody(row, workspaceDirForRun);
      body = loaded.body;
      incomplete = loaded.incomplete;
    }
    if (beforeRepairWrite) await beforeRepairWrite();
    if (stopped?.()) break;
    try {
      let skipped = false;
      db.transaction(() => {
        const fresh = db
          .prepare(`SELECT current_version, updated_at FROM artifacts WHERE key = ?`)
          .get(key) as { current_version: number; updated_at: string } | undefined;
        if (row === undefined) {
          if (fresh !== undefined) {
            markDirty(db, key);
            skipped = true;
            return;
          }
          unindexArtifactSearch(db, key);
          clearDirty(db, key);
          return;
        }
        if (
          fresh === undefined ||
          fresh.current_version !== row.current_version ||
          fresh.updated_at !== row.updated_at
        ) {
          markDirty(db, key);
          skipped = true;
          return;
        }
        syncArtifactSearch(
          db,
          {
            key: row.key,
            title: row.title,
            description: row.description,
            tagsJson: row.tags_json,
            summary: row.summary,
            ownerText: artifactSearchOwnerText(row),
            projectRootId: row.project_root_id,
            kind: row.kind,
            body,
            hidden: row.hidden,
            status: row.status,
            deleted: row.deleted_at != null,
          },
          { bodyIncomplete: incomplete },
        );
      })();
      repaired += 1;
      if (skipped) continue;
      const still = db.prepare(`SELECT 1 AS ok FROM artifact_search_dirty WHERE key = ?`).get(key) as
        | { ok: number }
        | undefined;
      if (still !== undefined && (incomplete || row === undefined)) {
        deferDirtyKey(db, key);
      }
    } catch (error) {
      if (stopped?.()) break;
      logIndexFailure(error);
      try {
        if (stopped?.()) break;
        markDirty(db, key);
        deferDirtyKey(db, key);
      } catch (markError) {
        if (stopped?.()) break;
        logIndexFailure(markError);
      }
    }
  }
  return repaired;
}

export async function repairArtifactSearchBudget(
  db: Database.Database,
  workspaceDirForRun?: (runId: string) => string,
  options?: {
    budgetMs?: number;
    now?: () => number;
    wait?: () => Promise<void>;
    batch?: number;
    stopped?: () => boolean;
  },
): Promise<{ pending: number; yielded: number; examined: number }> {
  const budgetMs = options?.budgetMs ?? ARTIFACT_SEARCH_START_BUDGET_MS;
  const now = options?.now ?? Date.now;
  const wait = options?.wait ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const batch = options?.batch ?? ARTIFACT_SEARCH_REPAIR_BATCH;
  const stopped = options?.stopped ?? (() => false);
  const pendingCount = (): number => {
    if (stopped()) return 0;
    return artifactSearchPendingCount(db);
  };
  const started = now();
  let yielded = 0;
  let examined = 0;
  try {
    while (pendingCount() > 0) {
      if (stopped() || now() - started >= budgetMs) break;
      const examinedBefore = examined;
      examined += await repairDirtyArtifactSearch(db, workspaceDirForRun, batch, stopped);
      if (stopped()) break;
      if (examined === examinedBefore) break;
      if (pendingCount() === 0) break;
      if (now() - started >= budgetMs) break;
      yielded += 1;
      await wait();
      if (stopped()) break;
    }
    return { pending: pendingCount(), yielded, examined };
  } catch (error) {
    if (stopped()) return { pending: 0, yielded, examined };
    throw error;
  }
}

export async function repairArtifactSearchOnHostStart(
  db: Database.Database,
  workspaceDirForRun?: (runId: string) => string,
  options?: {
    budgetMs?: number;
    now?: () => number;
    wait?: () => Promise<void>;
    scheduleTick?: (run: () => void) => void;
  },
): Promise<{ pending: number; yielded: number; examined: number }> {
  const epoch = repairEpoch;
  const stopped = () => repairEpoch !== epoch;
  try {
    if (stopped()) return { pending: 0, yielded: 0, examined: 0 };
    const before = artifactSearchPendingCount(db);
    const result = await repairArtifactSearchBudget(db, workspaceDirForRun, { ...options, stopped });
    if (!stopped() && result.pending > 0 && result.pending < before) {
      const schedule = options?.scheduleTick ?? ((run: () => void) => setImmediate(run));
      schedule(() => {
        if (stopped()) return;
        void repairArtifactSearchOnHostStart(db, workspaceDirForRun, options).catch((error) => {
          if (stopped()) return;
          logIndexFailure(error);
        });
      });
    }
    return result;
  } catch (error) {
    if (stopped()) return { pending: 0, yielded: 0, examined: 0 };
    throw error;
  }
}
