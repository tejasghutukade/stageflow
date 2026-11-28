import { isUtf8 } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { ownerMatchSql, ownerWorkspaceContent } from "./owners.js";
import { artifactOwnerKey, type ArtifactExpiredReason, type ArtifactOwner } from "./record.js";
import type { RunStore } from "../runstore/port.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import {
  PATH_DENIED_MESSAGE,
  artifactMediaType,
  resolveContainedRelativePath,
  type ContainedPathMessages,
} from "../runread/readArtifact.js";
import { artifactStorageKey } from "./keys.js";
import { readArtifact } from "./query.js";
import { readStoredArtifactFile } from "./store.js";
import { artifactVersionKind, readArtifactVersionRow, type ArtifactVersionRow } from "./versions.js";

/** Text and table bodies larger than this are not sent on the content route. Images are exempt. */
export const ARTIFACT_CONTENT_MAX_BYTES = 5 * 1024 * 1024;

export const STATIC_HTML_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'";

export function isHtmlContentPath(relativePath: string): boolean {
  const name = relativePath.replace(/\\/g, "/").split("/").pop() ?? relativePath;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

const PATH_MESSAGES: ContainedPathMessages = {
  relativeRequired: "path must be relative to the run workspace",
  escapes: "path escapes the run workspace",
  notFound: (relativePath) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

export class ArtifactContentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactContentError";
  }
}

export type ArtifactContentBody = {
  bytes: Buffer;
  contentType: string;
  contentHash: string | null;
  kind: string;
};

type ContentRow = {
  kind: string;
  source_run_id: string | null;
  source_stage_id: string | null;
  source_attempt: number | null;
  relative_path: string | null;
  content_hash: string | null;
  version_run_id: string | null;
  version_stage_id: string | null;
  version_attempt: number | null;
};

function unavailable(message: string): ArtifactContentError {
  return new ArtifactContentError(404, "artifact.content_unavailable", message);
}

export function expiredContentMessage(reason: ArtifactExpiredReason | string | null): string {
  if (reason === "run_slimmed" || reason === "run_purged" || reason === "run_deleted" || reason === "file_missing") {
    return `Artifact content is unavailable (${reason})`;
  }
  const named = typeof reason === "string" ? reason.trim() : "";
  if (named.length > 0) return `Artifact content is unavailable (${named})`;
  return "Artifact content is unavailable (expired)";
}

function denied(): ArtifactContentError {
  return new ArtifactContentError(403, "artifact.content_unavailable", "Artifact path denied");
}

export function contentTooLarge(size: number, image: boolean): boolean {
  return !image && size > ARTIFACT_CONTENT_MAX_BYTES;
}

export function servedArtifactMediaType(kind: string, relativePath: string, bytes: Buffer): string {
  const image = artifactMediaType(relativePath);
  if (kind === "static.image" || image !== undefined) {
    return image ?? "application/octet-stream";
  }
  if (!isUtf8(bytes)) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

function locateContent(
  db: Database.Database,
  owner: ArtifactOwner,
  id: string,
  projectId: string,
): ContentRow | undefined {
  const match = ownerMatchSql(owner, { alias: "a" });
  return db
    .prepare(
      `SELECT a.kind, a.source_run_id, a.source_stage_id, a.source_attempt,
              v.relative_path, v.content_hash,
              v.source_run_id AS version_run_id,
              v.source_stage_id AS version_stage_id,
              v.source_attempt AS version_attempt
       FROM artifacts a
       LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
       WHERE a.deleted_at IS NULL AND a.hidden = 0 AND a.id = @id
         AND a.project_root_id = @project
         AND ${match.sql}`,
    )
    .get({ id, project: projectId, ...match.params }) as ContentRow | undefined;
}

function mapPathError(error: unknown): ArtifactContentError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Artifact not found:") || message.startsWith("Run not found:")) {
    return unavailable("The artifact file is no longer in the run workspace");
  }
  return denied();
}

export async function readArtifactContent(
  db: Database.Database,
  store: RunStore,
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
  roots: readonly CatalogRoot[],
  version?: number,
): Promise<ArtifactContentBody> {
  const published = await readPublishedArtifactContent(
    db,
    store,
    ownerKey,
    id,
    projectRoot,
    roots,
    version,
  );
  if (published) return published;
  if (version !== undefined) {
    throw new ArtifactContentError(404, "artifact.not_found", "Artifact version not found");
  }
  const record = readArtifact(db, ownerKey, id, projectRoot, roots);
  if (record.status === "expired") {
    throw unavailable(expiredContentMessage(record.expired_reason));
  }
  if (!ownerWorkspaceContent(record.owner)) {
    throw unavailable("The artifact file is no longer in the store");
  }
  const row = locateContent(db, record.owner, record.id, record.project.id);
  if (!row || row.relative_path === null || row.relative_path.trim().length === 0) {
    throw unavailable("The artifact file is no longer in the run workspace");
  }
  const runId = row.version_run_id ?? row.source_run_id;
  const stageId = row.version_stage_id ?? row.source_stage_id;
  const attempt = row.version_attempt ?? row.source_attempt;
  if (!runId || !stageId || attempt === null || !Number.isInteger(attempt) || attempt < 1) {
    throw unavailable("The artifact file is no longer in the run workspace");
  }
  let absolute: string;
  try {
    await store.readRunMeta(runId);
    const artifactsDir = attemptArtifactsDir(store.getWorkspaceDir(runId), stageId, attempt);
    absolute = await resolveContainedRelativePath(artifactsDir, row.relative_path, PATH_MESSAGES);
  } catch (error) {
    throw mapPathError(error);
  }
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw unavailable("The artifact file is no longer in the run workspace");
  }
  if (!info.isFile()) {
    throw unavailable("The artifact file is no longer in the run workspace");
  }
  const image = record.kind === "static.image" || artifactMediaType(row.relative_path) !== undefined;
  if (contentTooLarge(info.size, image)) {
    throw new ArtifactContentError(
      413,
      "artifact.too_large",
      `Artifact content is larger than ${ARTIFACT_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const bytes = await readFile(absolute);
  if (contentTooLarge(bytes.length, image)) {
    throw new ArtifactContentError(
      413,
      "artifact.too_large",
      `Artifact content is larger than ${ARTIFACT_CONTENT_MAX_BYTES} bytes`,
    );
  }
  return {
    bytes,
    contentType: servedArtifactMediaType(record.kind, row.relative_path, bytes),
    contentHash: row.content_hash,
    kind: record.kind,
  };
}

function storageKeyForRecord(record: {
  id: string;
  project: { id: string };
  owner: ArtifactOwner;
}): string {
  return artifactStorageKey(record.project.id, artifactOwnerKey(record.owner), record.id);
}

async function readRunVersionContent(
  store: RunStore,
  kind: string,
  row: ArtifactVersionRow,
): Promise<ArtifactContentBody> {
  if (!row.relative_path) throw unavailable("The artifact file is no longer in the run workspace");
  const runId = row.source_run_id;
  const stageId = row.source_stage_id;
  const attempt = row.source_attempt;
  if (!runId || !stageId || attempt === null || !Number.isInteger(attempt) || attempt < 1) {
    throw unavailable("The artifact file is no longer in the run workspace");
  }
  let absolute: string;
  try {
    await store.readRunMeta(runId);
    const artifactsDir = attemptArtifactsDir(store.getWorkspaceDir(runId), stageId, attempt);
    absolute = await resolveContainedRelativePath(artifactsDir, row.relative_path, PATH_MESSAGES);
  } catch (error) {
    throw mapPathError(error);
  }
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) throw unavailable("The artifact file is no longer in the run workspace");
  const image = kind === "static.image" || artifactMediaType(row.relative_path) !== undefined;
  if (contentTooLarge(info.size, image)) {
    throw new ArtifactContentError(
      413,
      "artifact.too_large",
      `Artifact content is larger than ${ARTIFACT_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const bytes = await readFile(absolute);
  return {
    bytes,
    contentType: servedArtifactMediaType(kind, row.relative_path, bytes),
    contentHash: row.content_hash,
    kind,
  };
}

export async function readPublishedArtifactContent(
  db: Database.Database,
  store: RunStore,
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
  roots: readonly CatalogRoot[],
  version?: number,
): Promise<ArtifactContentBody | null> {
  const record = readArtifact(db, ownerKey, id, projectRoot, roots);
  if (version === undefined && record.origin !== "published") return null;
  const row = readArtifactVersionRow(db, storageKeyForRecord(record), version ?? record.version);
  if (!row) {
    throw new ArtifactContentError(404, "artifact.not_found", "Artifact version not found");
  }
  if (row.storage === "store") {
    if (!row.relative_path) {
      throw new ArtifactContentError(404, "artifact.not_found", "Artifact version not found");
    }
    let bytes: Buffer;
    try {
      bytes = await readStoredArtifactFile(storageKeyForRecord(record), row.version, row.relative_path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("escapes") || message === "Artifact path denied") throw denied();
      throw new ArtifactContentError(404, "artifact.not_found", "Artifact version not found");
    }
    const kind = artifactVersionKind(row.manifest_json) ?? record.kind;
    const image = kind === "static.image" || artifactMediaType(row.relative_path) !== undefined;
    if (contentTooLarge(bytes.length, image)) {
      throw new ArtifactContentError(
        413,
        "artifact.too_large",
        `Artifact content is larger than ${ARTIFACT_CONTENT_MAX_BYTES} bytes`,
      );
    }
    return {
      bytes,
      contentType: servedArtifactMediaType(kind, row.relative_path, bytes),
      contentHash: row.content_hash,
      kind,
    };
  }
  if (row.storage !== "store" && record.status === "expired") {
    throw unavailable(expiredContentMessage(record.expired_reason));
  }
  if (version === undefined) return null;
  return readRunVersionContent(store, record.kind, row);
}
