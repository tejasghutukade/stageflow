import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { TOOL_OUTPUT_ARTIFACT_DIR } from "../agent/toolOutputSpill.js";
import { WORKSPACE_CATALOG_ID } from "../project/workspaceCatalog.js";
import { acceptArtifactListedPath } from "../runtime/artifactPath.js";
import { indexedExpiresAt } from "../runstore/artifactRetention.js";
import type { RunStore } from "../runstore/port.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import {
  assertSafeRelativePath,
  PATH_DENIED_MESSAGE,
  resolveContainedRelativePath,
} from "../runread/readArtifact.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { contentTypeForKind, inferStaticKind } from "./kinds.js";
import {
  artifactSearchBodyKind,
  artifactSearchOwnerText,
  extractSearchBody,
  readBoundedSearchFile,
  syncArtifactSearch,
  unindexArtifactSearch,
} from "./search.js";
import {
  ArtifactKeyError,
  artifactIdFromRelative,
  artifactStorageKey,
  stageOwnerKey,
} from "./keys.js";
import { canonicalProjectWireId, catalogRootsForArtifacts } from "./projectScope.js";

/** Files larger than this are indexed with content_hash null. */
export const ARTIFACT_HASH_MAX_BYTES = 64 * 1024 * 1024;

const ARTIFACT_MESSAGES = {
  relativeRequired: "path must be relative to the run workspace",
  escapes: "path escapes the run workspace",
  notFound: (relativePath: string) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

let hashMaxBytes = ARTIFACT_HASH_MAX_BYTES;

export function setArtifactHashMaxBytesForTests(bytes: number | undefined): void {
  hashMaxBytes = bytes ?? ARTIFACT_HASH_MAX_BYTES;
}

type RunIndexRow = {
  pipeline_id: string;
  project_root: string | null;
  status: string;
  finished_at: string | null;
};

type PreparedArtifact = {
  id: string;
  title: string;
  relative: string;
  kind: string;
  contentType: string;
  size: number;
  hash: string | null;
  key: string;
  body: string;
  bodyIncomplete: boolean;
};

function exclusionReason(relativePath: string): string | undefined {
  let segments: string[];
  try {
    segments = assertSafeRelativePath(relativePath, ARTIFACT_MESSAGES);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (segments.some((segment) => segment === TOOL_OUTPUT_ARTIFACT_DIR)) return "tool-output";
  return undefined;
}

function capTitle(value: string): string {
  return value.length > 120 ? value.slice(0, 120) : value;
}

export function titlesForDeliverables(relativePaths: readonly string[]): string[] {
  const posix = relativePaths.map((relative) => relative.replace(/\\/g, "/"));
  const bases = posix.map((value) => path.posix.basename(value));
  const baseCount = new Map<string, number>();
  for (const base of bases) baseCount.set(base, (baseCount.get(base) ?? 0) + 1);
  const titled = posix.map((value, index) => {
    const base = bases[index] ?? value;
    if ((baseCount.get(base) ?? 0) <= 1) return capTitle(base);
    const parent = path.posix.basename(path.posix.dirname(value));
    if (parent.length > 0 && parent !== ".") return capTitle(`${parent}/${base}`);
    return capTitle(value);
  });
  const titleCount = new Map<string, number>();
  for (const title of titled) titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
  return titled.map((title, index) =>
    (titleCount.get(title) ?? 0) <= 1 ? title : capTitle(posix[index] ?? title),
  );
}

function storedProjectValue(projectRoot: string | null, roots: readonly CatalogRoot[]): string {
  const trimmed = projectRoot?.trim() ?? "";
  if (trimmed.length > 0) return trimmed;
  return roots.find((root) => root.kind === "workspace")?.project_root ?? WORKSPACE_CATALOG_ID;
}

async function sizeAndHash(absolute: string): Promise<{ size: number; hash: string | null }> {
  const info = await stat(absolute);
  if (info.size > hashMaxBytes) return { size: info.size, hash: null };
  const digest = createHash("sha256");
  await pipeline(createReadStream(absolute), digest);
  return { size: info.size, hash: digest.digest("hex") };
}

function deleteIndexed(
  db: Database.Database,
  clause: string,
  params: Record<string, string | number>,
  keepIds: readonly string[],
): void {
  const keep =
    keepIds.length === 0
      ? ""
      : ` AND id NOT IN (${keepIds.map((_, index) => `@keep${index}`).join(", ")})`;
  const keepParams: Record<string, string> = {};
  keepIds.forEach((id, index) => {
    keepParams[`keep${index}`] = id;
  });
  const bound = { ...params, ...keepParams };
  const keys = db
    .prepare(`SELECT key FROM artifacts WHERE origin = 'indexed' AND ${clause}${keep}`)
    .all(bound) as { key: string }[];
  for (const row of keys) unindexArtifactSearch(db, row.key);
  db.prepare(`DELETE FROM artifacts WHERE origin = 'indexed' AND ${clause}${keep}`).run(bound);
}

function clearAttemptRows(db: Database.Database, runId: string, stageId: string, attempt: number): void {
  db.transaction(() => {
    deleteIndexed(
      db,
      `source_run_id = @run_id AND source_stage_id = @stage_id AND source_attempt = @attempt`,
      { run_id: runId, stage_id: stageId, attempt },
      [],
    );
  })();
}

export async function indexDeclaredDeliverables(input: {
  db: Database.Database;
  store: RunStore;
  runId: string;
  stageId: string;
  attempt: number;
  envelope: StageEnvelope;
}): Promise<void> {
  if (input.envelope.status !== "success" || input.envelope.artifacts.length === 0) {
    clearAttemptRows(input.db, input.runId, input.stageId, input.attempt);
    return;
  }
  const run = input.db
    .prepare(
      `SELECT pipeline_id, project_root, status, finished_at FROM runs WHERE run_id = ?`,
    )
    .get(input.runId) as RunIndexRow | undefined;
  if (run === undefined) return;
  let ownerKey: string;
  try {
    ownerKey = stageOwnerKey(run.pipeline_id, input.stageId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Artifact index skipped ${input.runId}/${input.stageId}: ${message}`);
    return;
  }
  const roots = await catalogRootsForArtifacts(input.store);
  const project = canonicalProjectWireId(storedProjectValue(run.project_root, roots), roots);
  if (project.id.includes("::")) {
    console.error(
      `Artifact index skipped ${input.runId}/${input.stageId}: project id must not contain "::"`,
    );
    return;
  }
  const workspaceDir = input.store.getWorkspaceDir(input.runId);
  const artifactsDir = attemptArtifactsDir(workspaceDir, input.stageId, input.attempt);
  const now = new Date().toISOString();
  const expires = indexedExpiresAt(run.status, run.finished_at);
  const prepared: PreparedArtifact[] = [];

  for (const listed of input.envelope.artifacts) {
    try {
      const one = await prepareOne({
        listed,
        stageId: input.stageId,
        attempt: input.attempt,
        artifactsDir,
        ownerKey,
        projectId: project.id,
      });
      if (one) prepared.push(one);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Artifact index skipped ${input.runId}/${input.stageId} ${listed}: ${message}`);
    }
  }

  const titles = titlesForDeliverables(prepared.map((row) => row.relative));
  prepared.forEach((row, index) => {
    row.title = titles[index] ?? row.title;
  });
  const keepIds = prepared.map((row) => row.id);

  input.db.transaction(() => {
    for (const row of prepared) {
      writeRow(input.db, {
        row,
        pipelineId: run.pipeline_id,
        stageId: input.stageId,
        projectId: project.id,
        runId: input.runId,
        attempt: input.attempt,
        now,
        expires,
      });
    }
    const scope = { run_id: input.runId, stage_id: input.stageId, attempt: input.attempt };
    deleteIndexed(
      input.db,
      `source_run_id = @run_id AND source_stage_id = @stage_id AND source_attempt = @attempt`,
      scope,
      keepIds,
    );
    deleteIndexed(
      input.db,
      `source_run_id = @run_id AND source_stage_id = @stage_id AND source_attempt < @attempt`,
      scope,
      keepIds,
    );
  })();
}

async function prepareOne(input: {
  listed: string;
  stageId: string;
  attempt: number;
  artifactsDir: string;
  ownerKey: string;
  projectId: string;
}): Promise<PreparedArtifact | undefined> {
  const accepted = acceptArtifactListedPath(input.listed, {
    kind: "current_attempt",
    stageId: input.stageId,
    attempt: input.attempt,
  });
  if (accepted === undefined) return undefined;
  const relative = accepted.relative.replace(/\\/g, "/");
  if (exclusionReason(relative) !== undefined) return undefined;
  let id: string;
  try {
    id = artifactIdFromRelative(relative);
  } catch (error) {
    if (error instanceof ArtifactKeyError) return undefined;
    throw error;
  }
  const absolute = await resolveContainedRelativePath(input.artifactsDir, relative, ARTIFACT_MESSAGES);
  const { size, hash } = await sizeAndHash(absolute);
  const kind = inferStaticKind(relative);
  let body = "";
  let bodyIncomplete = false;
  if (artifactSearchBodyKind(kind)) {
    try {
      body = extractSearchBody(kind, await readBoundedSearchFile(absolute));
    } catch (error) {
      bodyIncomplete = true;
      console.error(
        `artifact search: body read failed for ${relative}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    id,
    title: path.posix.basename(relative),
    relative,
    kind,
    contentType: contentTypeForKind(kind, relative),
    size,
    hash,
    key: artifactStorageKey(input.projectId, input.ownerKey, id),
    body,
    bodyIncomplete,
  };
}

function writeRow(
  db: Database.Database,
  input: {
    row: PreparedArtifact;
    pipelineId: string;
    stageId: string;
    projectId: string;
    runId: string;
    attempt: number;
    now: string;
    expires: string | null;
  },
): void {
  const row = input.row;
  db.prepare(
    `INSERT INTO artifacts (
       key, owner_kind, owner_pipeline, owner_stage, owner_agent, project_root_id, id,
       title, description, tags_json, summary, kind, origin, current_version,
       source_run_id, source_stage_id, source_attempt, source_session_id, hidden,
       expires_at, status, expired_at, expired_reason, created_at, updated_at, deleted_at
     ) VALUES (
       @key, 'stage', @pipeline, @stage, NULL, @project, @id,
       @title, NULL, '[]', NULL, @kind, 'indexed', 1,
       @run_id, @stage_id, @attempt, NULL, 0,
       @expires_at, 'available', NULL, NULL, @now, @now, NULL
     )
     ON CONFLICT(key) DO UPDATE SET
       title = excluded.title,
       kind = excluded.kind,
       origin = 'indexed',
       current_version = 1,
       source_run_id = excluded.source_run_id,
       source_stage_id = excluded.source_stage_id,
       source_attempt = excluded.source_attempt,
       source_session_id = NULL,
       hidden = 0,
       expires_at = COALESCE(artifacts.expires_at, excluded.expires_at),
       status = 'available',
       expired_at = NULL,
       expired_reason = NULL,
       updated_at = excluded.updated_at,
       deleted_at = NULL
     WHERE artifacts.origin = 'indexed'
       AND (
         artifacts.source_run_id != excluded.source_run_id
         OR artifacts.source_stage_id != excluded.source_stage_id
         OR artifacts.source_attempt IS NULL
         OR artifacts.source_attempt <= excluded.source_attempt
       )`,
  ).run({
    key: row.key,
    pipeline: input.pipelineId,
    stage: input.stageId,
    project: input.projectId,
    id: row.id,
    title: row.title,
    kind: row.kind,
    run_id: input.runId,
    stage_id: input.stageId,
    attempt: input.attempt,
    expires_at: input.expires,
    now: input.now,
  });
  const stored = db
    .prepare(`SELECT origin, source_run_id, source_attempt FROM artifacts WHERE key = ?`)
    .get(row.key) as { origin: string; source_run_id: string | null; source_attempt: number | null } | undefined;
  if (stored?.origin !== "indexed") return;
  if (stored.source_run_id !== input.runId || stored.source_attempt !== input.attempt) return;
  db.prepare(
    `INSERT INTO artifact_versions (
       key, version, content_type, size_bytes, content_hash, manifest_json, library,
       library_version, source_run_id, source_stage_id, source_attempt, source_session_id,
       created_at, pinned, relative_path
     ) VALUES (
       @key, 1, @content_type, @size_bytes, @content_hash, NULL, NULL,
       NULL, @run_id, @stage_id, @attempt, NULL,
       @now, 0, @relative_path
     )
     ON CONFLICT(key, version) DO UPDATE SET
       content_type = excluded.content_type,
       size_bytes = excluded.size_bytes,
       content_hash = excluded.content_hash,
       source_run_id = excluded.source_run_id,
       source_stage_id = excluded.source_stage_id,
       source_attempt = excluded.source_attempt,
       relative_path = excluded.relative_path`,
  ).run({
    key: row.key,
    content_type: row.contentType,
    size_bytes: row.size,
    content_hash: row.hash,
    run_id: input.runId,
    stage_id: input.stageId,
    attempt: input.attempt,
    now: input.now,
    relative_path: row.relative,
  });
  const storedNow = db
    .prepare(
      `SELECT owner_kind, owner_pipeline, owner_stage, owner_agent, hidden, status, deleted_at
       FROM artifacts WHERE key = ?`,
    )
    .get(row.key) as
    | {
        owner_kind: string;
        owner_pipeline: string | null;
        owner_stage: string | null;
        owner_agent: string | null;
        hidden: number;
        status: string | null;
        deleted_at: string | null;
      }
    | undefined;
  if (storedNow === undefined) return;
  syncArtifactSearch(
    db,
    {
      key: row.key,
      title: row.title,
      description: null,
      tagsJson: "[]",
      summary: null,
      ownerText: artifactSearchOwnerText(storedNow),
      projectRootId: input.projectId,
      kind: row.kind,
      body: row.body,
      hidden: storedNow.hidden,
      status: storedNow.status,
      deleted: storedNow.deleted_at != null,
    },
    { bodyIncomplete: row.bodyIncomplete },
  );
}
