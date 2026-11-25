import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type Database from "better-sqlite3";
import { AGENT_ID_PATTERN } from "../agents/agentId.js";
import { agentProjectKey } from "../agents/store.js";
import { STAGE_ID_PATTERN } from "../config/createStage.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { ArtifactKeyError, artifactStorageKey, assertArtifactId, publicArtifactKey, stageOwnerKey } from "./keys.js";
import { assertBindingsAtPublish } from "./bindings.js";
import { assertHtmlDocumentAtPublish } from "./htmlScan.js";
import { htmlDbManifest, htmlIdentityHash, validateHtmlManifest, type HtmlManifest } from "./htmlManifest.js";
import { assertLiveProgramAtPublish } from "./program.js";
import { contentTypeForKind, isLiveDeclarativeKind, isLiveHtmlKind, LIVE_DECLARATIVE_KIND, type StaticArtifactKind } from "./kinds.js";
import {
  ARTIFACT_DESCRIPTION_MAX_CHARS,
  ARTIFACT_SUMMARY_MAX_CHARS,
  ARTIFACT_TAG_MAX,
  ARTIFACT_TAG_PATTERN,
  ARTIFACT_TITLE_MAX_CHARS,
  LIVE_HTML_MAX_BYTES,
  LIVE_PROGRAM_MAX_BYTES,
  STATIC_CONTENT_MAX_BYTES,
  ArtifactPublishError,
  artifactVersionsToKeep,
  type ArtifactIssue,
} from "./limits.js";
import { liveDbManifest, liveIdentityHash, validateLiveManifest, type LiveManifest } from "./manifest.js";
import type { ArtifactOwner } from "./record.js";
import { canonicalProjectWireId } from "./projectScope.js";
import {
  artifactSearchOwnerText,
  extractSearchBody,
  syncArtifactSearch,
  unindexArtifactSearch,
} from "./search.js";
import { ArtifactQueryError, readArtifact } from "./query.js";
import { reconcileLiveSnapshots, withRefreshLock } from "./refresh.js";
import {
  promoteStagedVersionSync,
  removeOrphanVersionSync,
  removeStoredArtifact,
  removeStoredDirectory,
  stageStoredContent,
  sweepStaleStagingDirectoriesSync,
  versionDirectoryExistsSync,
} from "./store.js";
import { pruneArtifactVersions } from "./versions.js";

const STATIC_KINDS = new Set<StaticArtifactKind>([
  "static.markdown",
  "static.image",
  "static.table",
  "static.text",
  "static.html",
]);

const OWNER_ID_MAX = 64;
const PUBLISH_VERSION_ATTEMPTS = 8;

/** Publish lock. Delete also takes the refresh lock after this one. See withRefreshLock. */
const publishChains = new Map<string, Promise<void>>();
let keyOperationTrace: ((op: "publish" | "delete") => void) | undefined;
let failAfterVersionInsert = false;

/** Throws inside the publish transaction after the version, provenance, and attempt rows are written. */
export function setPublishVersionInsertFailureForTests(enabled: boolean): void {
  failAfterVersionInsert = enabled;
}

export function setArtifactKeyOperationTraceForTests(fn?: (op: "publish" | "delete") => void): void {
  keyOperationTrace = fn;
}

function withPublishLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = publishChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  publishChains.set(key, tail);
  void tail.then(() => {
    if (publishChains.get(key) === tail) publishChains.delete(key);
  });
  return run;
}

function isRetryableVersionConflict(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return (
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "ARTIFACT_VERSION_CONFLICT"
  );
}

export type PublishSource = "console" | "api";

export type PublishProvenanceKind = "console" | "api" | "mcp" | "stage" | "agent";

/** Publisher of this call. Written with the version row. Not taken from a request body. */
export type PublishProvenance = {
  kind: PublishProvenanceKind;
  runId?: string;
  stageId?: string;
  attempt?: number;
  sessionId?: string | null;
};

export type PublishRequest = {
  owner: ArtifactOwner;
  projectRoot?: string;
  id: string;
  kind: string;
  title: string;
  description?: string | null;
  tags?: string[];
  summary?: string | null;
  bytes: Buffer;
  /** Required for a live artifact. The program or HTML document is `bytes`. */
  manifest?: unknown;
  publishSource: PublishSource;
  /** When set, `artifacts.source` is `kind` and the version row stores the run, stage, attempt, and session. */
  source?: PublishProvenance;
  /** Internal. Eval publishes set this. Request bodies must not set it. */
  hidden?: boolean;
  /** Internal. Eval-origin publishes store under `eval:` so they cannot replace a visible artifact. */
  ownerNamespace?: "eval";
  roots: readonly CatalogRoot[];
  now?: string;
};

export type PublishResult = {
  key: string;
  version: number;
  project_root: string;
  url: string;
  unchanged: boolean;
  agent_unverified?: true;
  warnings?: ArtifactIssue[];
};

type ResolvedProject = { id: string; path: string };

function fail(
  status: number,
  code: string,
  path: string,
  message: string,
  projectRoots?: string[],
): never {
  const issues: ArtifactIssue[] = [{ path, message }];
  throw new ArtifactPublishError(status, code, message, issues, projectRoots);
}

function acceptedKind(kind: string): string {
  if (kind === LIVE_DECLARATIVE_KIND || isLiveHtmlKind(kind) || STATIC_KINDS.has(kind as StaticArtifactKind)) return kind;
  fail(400, "artifact.invalid_kind", "kind", `Unsupported artifact kind: ${kind}`);
}

function assertOwnerId(value: string, issuePath: string, pattern: RegExp, label: string): void {
  if (value.includes("::")) {
    fail(400, "artifact.invalid_id", issuePath, `${label} must not contain "::"`);
  }
  if (
    value.length === 0 ||
    value.length > OWNER_ID_MAX ||
    value.includes("..") ||
    value.includes("\0") ||
    !pattern.test(value)
  ) {
    fail(400, "artifact.invalid_shape", issuePath, `${label} is not a valid id`);
  }
}

function rejectEvalOwnerPiece(value: string, issuePath: string): void {
  if (value.startsWith("eval:") || value.includes(":")) {
    fail(400, "artifact.invalid_shape", issuePath, "owner must not use the eval namespace");
  }
}

function ownerKeyOf(owner: ArtifactOwner): string {
  try {
    if (owner.kind === "agent") {
      rejectEvalOwnerPiece(owner.agent, "owner.agent");
      assertOwnerId(owner.agent, "owner.agent", AGENT_ID_PATTERN, "Agent id");
      return `agent:${owner.agent}`;
    }
    rejectEvalOwnerPiece(owner.pipeline, "owner.pipeline");
    rejectEvalOwnerPiece(owner.stage, "owner.stage");
    assertOwnerId(owner.pipeline, "owner.pipeline", STAGE_ID_PATTERN, "Pipeline id");
    assertOwnerId(owner.stage, "owner.stage", STAGE_ID_PATTERN, "Stage id");
    return stageOwnerKey(owner.pipeline, owner.stage);
  } catch (error) {
    if (error instanceof ArtifactPublishError) throw error;
    if (error instanceof ArtifactKeyError) {
      fail(400, "artifact.invalid_id", "owner", error.message);
    }
    throw error;
  }
}

function resolveProject(projectRoot: string | undefined, roots: readonly CatalogRoot[]): ResolvedProject {
  if (projectRoot !== undefined && projectRoot.trim().length > 0) {
    const canonical = canonicalProjectWireId(projectRoot, roots);
    if (!canonical.registered) {
      fail(400, "artifact.invalid_shape", "project_root", "project_root is not a catalog root");
    }
    if (canonical.id.includes("::")) {
      fail(400, "artifact.invalid_id", "project_root", `Project id must not contain "::"`);
    }
    const match = roots.find((root) => root.project_root === canonical.id);
    return { id: canonical.id, path: match?.path ?? canonical.id };
  }
  const available = roots.filter((root) => root.available !== false);
  if (available.length === 1) {
    return { id: available[0]!.project_root, path: available[0]!.path };
  }
  const ids = [...new Set(available.map((root) => root.project_root))].sort();
  throw new ArtifactPublishError(
    409,
    "artifact.ambiguous",
    "project_root is required when more than one project is registered",
    [{ path: "project_root", message: "required when more than one project is registered" }],
    ids,
  );
}

function agentState(
  db: Database.Database,
  projectPath: string,
  agentId: string,
): "found" | "missing" | "unverified" {
  try {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_definitions'`)
      .get() as { name: string } | undefined;
    if (!table) return "unverified";
    const row = db
      .prepare(`SELECT 1 AS ok FROM agent_definitions WHERE project_key = ? AND agent_id = ?`)
      .get(agentProjectKey(projectPath), agentId) as { ok: number } | undefined;
    return row ? "found" : "missing";
  } catch {
    return "unverified";
  }
}

function imageExtension(bytes: Buffer): "png" | "jpg" | "gif" | "webp" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6) {
    const magic = bytes.subarray(0, 6).toString("ascii");
    if (magic === "GIF87a" || magic === "GIF89a") return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

function tableIsJsonArrayOfObjects(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

function tableIsCsv(text: string): boolean {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const pushRow = (): void => {
    row.push(field);
    field = "";
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += ch;
    }
  }
  if (quoted) return false;
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return false;
  const width = rows[0]!.length;
  return width > 0 && rows.every((item) => item.length === width);
}

function contentFileName(kind: string, bytes: Buffer): string {
  if (isLiveDeclarativeKind(kind)) {
    if (!isUtf8(bytes)) fail(400, "artifact.invalid_shape", "content", "Program must be valid UTF-8");
    return "program.txt";
  }
  if (isLiveHtmlKind(kind)) {
    if (!isUtf8(bytes)) fail(400, "artifact.invalid_shape", "content", "HTML must be valid UTF-8");
    return "document.html";
  }
  if (kind === "static.markdown") {
    if (!isUtf8(bytes)) fail(400, "artifact.invalid_shape", "content", "Markdown must be valid UTF-8");
    return "content.md";
  }
  if (kind === "static.text") {
    if (!isUtf8(bytes)) fail(400, "artifact.invalid_shape", "content", "Text must be valid UTF-8");
    return "content.txt";
  }
  if (kind === "static.html") return "content.html";
  if (kind === "static.image") {
    const ext = imageExtension(bytes);
    if (!ext) fail(400, "artifact.invalid_shape", "content", "Image must be png, jpeg, gif, or webp");
    return `content.${ext}`;
  }
  if (!isUtf8(bytes)) fail(400, "artifact.invalid_shape", "content", "Table must be valid UTF-8");
  const text = bytes.toString("utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    if (!tableIsJsonArrayOfObjects(text)) {
      fail(400, "artifact.invalid_shape", "content", "Table JSON must be an array of objects");
    }
    return "content.json";
  }
  if (!tableIsCsv(text)) {
    fail(400, "artifact.invalid_shape", "content", "Table must be CSV or a JSON array of objects");
  }
  return "content.csv";
}

function validateRequest(input: PublishRequest): {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  tags: string[];
  summary: string | null;
  fileName: string;
  live?: LiveManifest;
  html?: HtmlManifest;
} {
  if (typeof input.id !== "string") fail(400, "artifact.invalid_shape", "id", "id must be a string");
  try {
    assertArtifactId(input.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact id is not valid";
    fail(400, "artifact.invalid_id", "id", message);
  }
  if (typeof input.kind !== "string") fail(400, "artifact.invalid_shape", "kind", "kind must be a string");
  const kind = acceptedKind(input.kind);
  if (typeof input.title !== "string") fail(400, "artifact.invalid_shape", "title", "title must be a string");
  const title = input.title.trim();
  if (title.length === 0) fail(400, "artifact.invalid_shape", "title", "title is required");
  if (title.length > ARTIFACT_TITLE_MAX_CHARS) {
    fail(400, "artifact.invalid_shape", "title", `title must be at most ${ARTIFACT_TITLE_MAX_CHARS} characters`);
  }
  let description: string | null = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") {
      fail(400, "artifact.invalid_shape", "description", "description must be a string");
    }
    if (input.description.length > ARTIFACT_DESCRIPTION_MAX_CHARS) {
      fail(
        400,
        "artifact.invalid_shape",
        "description",
        `description must be at most ${ARTIFACT_DESCRIPTION_MAX_CHARS} characters`,
      );
    }
    description = input.description;
  }
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    fail(400, "artifact.invalid_shape", "tags", "tags must be an array of strings");
  }
  if (tags.length > ARTIFACT_TAG_MAX) {
    fail(400, "artifact.invalid_shape", "tags", `at most ${ARTIFACT_TAG_MAX} tags`);
  }
  for (const tag of tags) {
    if (tag !== tag.toLowerCase() || !ARTIFACT_TAG_PATTERN.test(tag)) {
      fail(400, "artifact.invalid_shape", "tags", "tags must be lowercase [a-z0-9_-]{1,32}");
    }
  }
  let summary: string | null = null;
  if (input.summary !== undefined && input.summary !== null) {
    if (typeof input.summary !== "string") fail(400, "artifact.invalid_shape", "summary", "summary must be a string");
    if (input.summary.length > ARTIFACT_SUMMARY_MAX_CHARS) {
      fail(400, "artifact.invalid_shape", "summary", `summary must be at most ${ARTIFACT_SUMMARY_MAX_CHARS} characters`);
    }
    summary = input.summary;
  }
  if (!Buffer.isBuffer(input.bytes)) fail(400, "artifact.invalid_shape", "content", "content is required");
  const cap = isLiveHtmlKind(kind)
    ? LIVE_HTML_MAX_BYTES
    : isLiveDeclarativeKind(kind)
      ? LIVE_PROGRAM_MAX_BYTES
      : STATIC_CONTENT_MAX_BYTES;
  if (input.bytes.length > cap) {
    fail(413, "artifact.too_large", "content", `content is larger than ${cap} bytes`);
  }
  let live: LiveManifest | undefined;
  let html: HtmlManifest | undefined;
  if (isLiveDeclarativeKind(kind)) {
    if (!isUtf8(input.bytes)) fail(400, "artifact.invalid_shape", "content", "Program must be valid UTF-8");
    if (input.manifest === undefined) {
      fail(400, "artifact.invalid_shape", "manifest", "manifest is required for a live artifact");
    }
    live = validateLiveManifest(input.manifest, input.bytes.toString("utf8"));
  } else if (isLiveHtmlKind(kind)) {
    if (!isUtf8(input.bytes)) fail(400, "artifact.invalid_shape", "content", "HTML must be valid UTF-8");
    if (input.manifest === undefined) {
      fail(400, "artifact.invalid_shape", "manifest", "manifest is required for a live artifact");
    }
    html = validateHtmlManifest(input.manifest);
  } else if (input.manifest !== undefined) {
    fail(400, "artifact.invalid_shape", "manifest", "manifest is only valid for a live artifact");
  }
  const fileName = contentFileName(kind, input.bytes);
  return {
    id: input.id,
    kind,
    title,
    description,
    tags,
    summary,
    fileName,
    ...(live ? { live } : {}),
    ...(html ? { html } : {}),
  };
}

function syncPublishedSearch(
  db: Database.Database,
  storageKey: string,
  fields: { title: string; description: string | null; tags: string[]; summary: string | null; kind: string },
  input: PublishRequest,
  projectId: string,
  body: string,
): void {
  const stored = db
    .prepare(`SELECT hidden, status, deleted_at FROM artifacts WHERE key = ?`)
    .get(storageKey) as { hidden: number; status: string | null; deleted_at: string | null } | undefined;
  syncArtifactSearch(db, {
    key: storageKey,
    title: fields.title,
    description: fields.description,
    tagsJson: JSON.stringify(fields.tags),
    summary: fields.summary,
    ownerText: artifactSearchOwnerText({
      owner_kind: input.owner.kind,
      owner_pipeline: input.owner.kind === "stage" ? input.owner.pipeline : null,
      owner_stage: input.owner.kind === "stage" ? input.owner.stage : null,
      owner_agent: input.owner.kind === "agent" ? input.owner.agent : null,
    }),
    projectRootId: projectId,
    kind: fields.kind,
    body,
    hidden: stored?.hidden ?? 0,
    status: stored?.status ?? "available",
    deleted: stored?.deleted_at != null,
  });
}

function provenanceOf(input: PublishRequest): {
  source_kind: string;
  source_run_id: string | null;
  source_stage_id: string | null;
  source_attempt: number | null;
  source_session_id: string | null;
  hidden: number;
} {
  const source = input.source;
  return {
    source_kind: source?.kind ?? input.publishSource,
    source_run_id: source?.runId ?? null,
    source_stage_id: source?.stageId ?? null,
    source_attempt: source?.attempt ?? null,
    source_session_id: source?.sessionId ?? null,
    hidden: input.ownerNamespace === "eval" || input.hidden === true ? 1 : 0,
  };
}

function recordAttemptPublish(
  db: Database.Database,
  input: PublishRequest,
  storageKey: string,
  version: number,
  unchanged: boolean,
  now: string,
): void {
  const source = input.source;
  if (source?.runId === undefined || source.stageId === undefined || source.attempt === undefined) return;
  db.prepare(
    `INSERT OR REPLACE INTO artifact_attempt_publishes (
       run_id, stage_id, attempt, artifact_key, version, unchanged, created_at
     ) VALUES (
       @run_id, @stage_id, @attempt, @artifact_key, @version, @unchanged, @created_at
     )`,
  ).run({
    run_id: source.runId,
    stage_id: source.stageId,
    attempt: source.attempt,
    artifact_key: storageKey,
    version,
    unchanged: unchanged ? 1 : 0,
    created_at: now,
  });
}

function artifactUrl(ownerKey: string, id: string, projectId: string): string {
  const params = new URLSearchParams();
  params.set("project_root", projectId);
  return `/artifacts/${encodeURIComponent(ownerKey)}/${encodeURIComponent(id)}?${params.toString()}`;
}

type CurrentRow = {
  origin: string;
  kind: string;
  current_version: number;
  content_hash: string | null;
  storage: string | null;
};

export async function publishArtifact(
  db: Database.Database,
  input: PublishRequest,
): Promise<PublishResult> {
  const keep = artifactVersionsToKeep();
  const fields = validateRequest(input);
  const ownerKey = input.ownerNamespace === "eval" ? `eval:${ownerKeyOf(input.owner)}` : ownerKeyOf(input.owner);
  const project = resolveProject(input.projectRoot, input.roots);
  let agentUnverified = false;
  if (input.owner.kind === "agent") {
    const state = agentState(db, project.path, input.owner.agent);
    if (state === "missing") {
      fail(400, "artifact.invalid_shape", "owner", "Agent was not found in this project");
    }
    agentUnverified = state === "unverified";
  }
  const storageKey = artifactStorageKey(project.id, ownerKey, fields.id);
  const publicKey = publicArtifactKey(ownerKey, fields.id);
  const now = input.now ?? new Date().toISOString();
  let programWarnings: ArtifactIssue[] = [];
  if (fields.live) {
    await assertBindingsAtPublish(project.path, input.owner, fields.live.bindings);
    programWarnings = await assertLiveProgramAtPublish(project.path, fields.live);
  } else if (fields.html) {
    await assertBindingsAtPublish(project.path, input.owner, fields.html.bindings);
    programWarnings = await assertHtmlDocumentAtPublish(input.bytes.toString("utf8"), fields.html.csp);
  }
  const contentHash = fields.html
    ? htmlIdentityHash(input.bytes, fields.html)
    : fields.live
      ? liveIdentityHash(input.bytes, fields.live)
      : createHash("sha256").update(input.bytes).digest("hex");
  const storedManifest = fields.html
    ? htmlDbManifest(fields.html)
    : fields.live
      ? liveDbManifest(fields.live)
      : { kind: fields.kind };
  const contentType = contentTypeForKind(fields.kind, fields.fileName);
  const provenance = provenanceOf(input);
  const flags = agentUnverified ? { agent_unverified: true as const } : {};

  return withPublishLock(storageKey, async () => {
    try {
      try {
        sweepStaleStagingDirectoriesSync(storageKey);
      } catch (error) {
        console.error(
          `artifact publish: staging sweep failed for ${publicKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const current = db
      .prepare(
        `SELECT a.origin, a.kind, a.current_version, v.content_hash, v.storage
         FROM artifacts a
         LEFT JOIN artifact_versions v ON v.key = a.key AND v.version = a.current_version
         WHERE a.key = ?`,
      )
      .get(storageKey) as CurrentRow | undefined;

    const unchanged =
      current !== undefined &&
      current.origin === "published" &&
      current.storage === "store" &&
      current.kind === fields.kind &&
      current.content_hash === contentHash;

    if (unchanged && current) {
      const searchBody = extractSearchBody(fields.kind, input.bytes);
      db.transaction(() => {
        db.prepare(
          `UPDATE artifacts
           SET title = @title,
               description = @description,
               tags_json = @tags_json,
               summary = @summary,
               updated_at = @updated_at,
               status = 'available',
               expires_at = NULL,
               expired_at = NULL,
               expired_reason = NULL,
               deleted_at = NULL
           WHERE key = @key`,
        ).run({
          key: storageKey,
          title: fields.title,
          description: fields.description,
          tags_json: JSON.stringify(fields.tags),
          summary: fields.summary,
          updated_at: now,
        });
        recordAttemptPublish(db, input, storageKey, current.current_version, true, now);
        syncPublishedSearch(db, storageKey, fields, input, project.id, searchBody);
      })();
      return {
        key: publicKey,
        version: current.current_version,
        project_root: project.id,
        url: artifactUrl(ownerKey, fields.id, project.id),
        unchanged: true,
        ...flags,
        ...(programWarnings.length > 0 ? { warnings: programWarnings } : {}),
      };
    }

    const version = await claimNextVersion();
    try {
      await pruneArtifactVersions(db, storageKey, version, keep);
    } catch (error) {
      console.error(
        `artifact publish: prune failed for ${publicKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      key: publicKey,
      version,
      project_root: project.id,
      url: artifactUrl(ownerKey, fields.id, project.id),
      unchanged: false,
      ...flags,
      ...(programWarnings.length > 0 ? { warnings: programWarnings } : {}),
    };
    } finally {
      keyOperationTrace?.("publish");
    }
  });

  async function claimNextVersion(): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PUBLISH_VERSION_ATTEMPTS; attempt++) {
      const stagingName = await stageStoredContent({
        storageKey,
        fileName: fields.fileName,
        bytes: input.bytes,
      });
      let createdDirectory: string | null = null;
      try {
        const claimed = db.transaction(() => {
          const readMax = (): number => {
            const maxRow = db
              .prepare(`SELECT MAX(version) AS version FROM artifact_versions WHERE key = ?`)
              .get(storageKey) as { version: number | null };
            return maxRow.version ?? 0;
          };
          const rowExists = (version: number): boolean => {
            const row = db
              .prepare(`SELECT 1 AS ok FROM artifact_versions WHERE key = ? AND version = ?`)
              .get(storageKey, version) as { ok: number } | undefined;
            return row !== undefined;
          };
          let next = readMax() + 1;
          for (let guard = 0; guard < 32; guard++) {
            if (rowExists(next)) {
              const reread = readMax() + 1;
              next = reread > next ? reread : next + 1;
              continue;
            }
            if (versionDirectoryExistsSync(storageKey, next)) {
              removeOrphanVersionSync(storageKey, next);
            }
            break;
          }
          if (rowExists(next) || versionDirectoryExistsSync(storageKey, next)) {
            throw Object.assign(new Error("version directory already exists"), {
              code: "ARTIFACT_VERSION_CONFLICT",
            });
          }
          createdDirectory = promoteStagedVersionSync({
            storageKey,
            stagingName,
            version: next,
            manifest: {
              key: storageKey,
              version: next,
              kind: fields.kind,
              content_file: fields.fileName,
              content_hash: contentHash,
              size_bytes: input.bytes.length,
              content_type: contentType,
              created_at: now,
              ...storedManifest,
            },
          });
          const exists = db.prepare(`SELECT 1 AS ok FROM artifacts WHERE key = ?`).get(storageKey) as
            | { ok: number }
            | undefined;
          if (exists) {
            db.prepare(
              `UPDATE artifacts
               SET title = @title,
                   description = @description,
                   tags_json = @tags_json,
                   summary = @summary,
                   kind = @kind,
                   origin = 'published',
                   current_version = @version,
                   source = @source,
                   source_run_id = @source_run_id,
                   source_stage_id = @source_stage_id,
                   source_attempt = @source_attempt,
                   source_session_id = @source_session_id,
                   hidden = @hidden,
                   updated_at = @updated_at,
                   status = 'available',
                   expires_at = NULL,
                   expired_at = NULL,
                   expired_reason = NULL,
                   deleted_at = NULL
               WHERE key = @key`,
            ).run({
              key: storageKey,
              title: fields.title,
              description: fields.description,
              tags_json: JSON.stringify(fields.tags),
              summary: fields.summary,
              kind: fields.kind,
              version: next,
              source: provenance.source_kind,
              source_run_id: provenance.source_run_id,
              source_stage_id: provenance.source_stage_id,
              source_attempt: provenance.source_attempt,
              source_session_id: provenance.source_session_id,
              hidden: provenance.hidden,
              updated_at: now,
            });
          } else {
            const owner = input.owner;
            db.prepare(
              `INSERT INTO artifacts (
                 key, owner_kind, owner_pipeline, owner_stage, owner_agent, project_root_id, id,
                 title, description, tags_json, summary, kind, origin, current_version,
                 source_run_id, source_stage_id, source_attempt, source_session_id, hidden,
                 created_at, updated_at, source, status
               ) VALUES (
                 @key, @owner_kind, @owner_pipeline, @owner_stage, @owner_agent, @project_root_id, @id,
                 @title, @description, @tags_json, @summary, @kind, 'published', @version,
                 @source_run_id, @source_stage_id, @source_attempt, @source_session_id, @hidden,
                 @created_at, @updated_at, @source, 'available'
               )`,
            ).run({
              key: storageKey,
              owner_kind: owner.kind,
              owner_pipeline: owner.kind === "stage" ? owner.pipeline : null,
              owner_stage: owner.kind === "stage" ? owner.stage : null,
              owner_agent: owner.kind === "agent" ? owner.agent : null,
              project_root_id: project.id,
              id: fields.id,
              title: fields.title,
              description: fields.description,
              tags_json: JSON.stringify(fields.tags),
              summary: fields.summary,
              kind: fields.kind,
              version: next,
              source_run_id: provenance.source_run_id,
              source_stage_id: provenance.source_stage_id,
              source_attempt: provenance.source_attempt,
              source_session_id: provenance.source_session_id,
              hidden: provenance.hidden,
              created_at: now,
              updated_at: now,
              source: provenance.source_kind,
            });
          }
          db.prepare(
            `INSERT INTO artifact_versions (
               key, version, content_type, size_bytes, content_hash, manifest_json,
               source_run_id, source_stage_id, source_attempt, source_session_id,
               created_at, pinned, relative_path, storage
             ) VALUES (
               @key, @version, @content_type, @size_bytes, @content_hash, @manifest_json,
               @source_run_id, @source_stage_id, @source_attempt, @source_session_id,
               @created_at, 0, @relative_path, 'store'
             )`,
          ).run({
            key: storageKey,
            version: next,
            content_type: contentType,
            size_bytes: input.bytes.length,
            content_hash: contentHash,
            manifest_json: JSON.stringify(storedManifest),
            source_run_id: provenance.source_run_id,
            source_stage_id: provenance.source_stage_id,
            source_attempt: provenance.source_attempt,
            source_session_id: provenance.source_session_id,
            created_at: now,
            relative_path: fields.fileName,
          });
          recordAttemptPublish(db, input, storageKey, next, false, now);
          syncPublishedSearch(db, storageKey, fields, input, project.id, extractSearchBody(fields.kind, input.bytes));
          reconcileLiveSnapshots(db, storageKey, fields.live ?? fields.html ?? null);
          if (failAfterVersionInsert) {
            failAfterVersionInsert = false;
            throw new Error("injected publish version insert failure");
          }
          return next;
        }).immediate();
        return claimed;
      } catch (error) {
        if (createdDirectory !== null) await removeStoredDirectory(storageKey, createdDirectory);
        else await removeStoredDirectory(storageKey, stagingName);
        lastError = error;
        if (isRetryableVersionConflict(error) && attempt + 1 < PUBLISH_VERSION_ATTEMPTS) continue;
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("publish version conflict");
  }
}

function storageKeyForDelete(projectId: string, ownerKey: string, id: string): string {
  try {
    return artifactStorageKey(projectId, ownerKey, id);
  } catch (error) {
    if (error instanceof ArtifactKeyError) {
      throw new ArtifactQueryError(400, "artifact.invalid_id", error.message);
    }
    throw error;
  }
}

function locateDeleteTarget(
  db: Database.Database,
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
  roots: readonly CatalogRoot[],
): { storageKey: string; projectId: string } {
  const specified = projectRoot !== undefined && projectRoot.trim().length > 0;
  const available = roots.filter((root) => root.available !== false);
  if (!specified && available.length === 1) {
    const project = resolveProject(undefined, roots);
    return { projectId: project.id, storageKey: storageKeyForDelete(project.id, ownerKey, id) };
  }
  if (specified) {
    const canonical = canonicalProjectWireId(projectRoot, roots);
    if (canonical.id.includes("::")) {
      throw new ArtifactQueryError(400, "artifact.invalid_id", `Project id must not contain "::"`);
    }
    return { projectId: canonical.id, storageKey: storageKeyForDelete(canonical.id, ownerKey, id) };
  }
  const record = readArtifact(db, ownerKey, id, undefined, roots);
  const owner =
    record.owner.kind === "agent"
      ? `agent:${record.owner.agent}`
      : stageOwnerKey(record.owner.pipeline, record.owner.stage);
  return {
    projectId: record.project.id,
    storageKey: storageKeyForDelete(record.project.id, owner, record.id),
  };
}

export async function deletePublishedArtifact(
  db: Database.Database,
  ownerKey: string,
  id: string,
  projectRoot: string | undefined,
  roots: readonly CatalogRoot[],
): Promise<{ key: string; project_root: string }> {
  const located = locateDeleteTarget(db, ownerKey, id, projectRoot, roots);
  return withPublishLock(located.storageKey, () =>
    withRefreshLock(
      located.storageKey,
      async () => {
    try {
      const record = readArtifact(db, ownerKey, id, located.projectId, roots);
      if (record.origin !== "published") {
        throw new ArtifactPublishError(
          409,
          "artifact.not_deletable",
          "Indexed artifacts are removed only when their run is deleted",
          [{ path: "origin", message: "indexed artifacts are removed only when their run is deleted" }],
        );
      }
      const owner =
        record.owner.kind === "agent"
          ? `agent:${record.owner.agent}`
          : stageOwnerKey(record.owner.pipeline, record.owner.stage);
      const storageKey = artifactStorageKey(record.project.id, owner, record.id);
      db.transaction(() => {
        unindexArtifactSearch(db, storageKey);
        db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(storageKey);
        db.prepare(`DELETE FROM artifact_versions WHERE key = ?`).run(storageKey);
        db.prepare(`DELETE FROM artifacts WHERE key = ?`).run(storageKey);
      }).immediate();
      try {
        await removeStoredArtifact(storageKey);
      } catch (error) {
        console.error(
          `artifact delete: failed to remove store directory for ${record.key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return { key: record.key, project_root: record.project.id };
    } finally {
      keyOperationTrace?.("delete");
    }
      },
      "mutate",
    ),
  );
}
