import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStore } from "../runstore/port.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { ArtifactContentError, readArtifactContent, STATIC_HTML_CONTENT_SECURITY_POLICY } from "../artifacts/content.js";
import { isLiveHtmlKind, isLiveKind } from "../artifacts/kinds.js";
import { approveOrigins, originApprovalView, revokeOrigins } from "../artifacts/originApproval.js";
import { artifactStorageKey } from "../artifacts/keys.js";
import { artifactLiveManifestFields, artifactOwnerKey, type ArtifactOwner } from "../artifacts/record.js";
import { ArtifactPublishError, STATIC_CONTENT_MAX_BYTES } from "../artifacts/limits.js";
import { deletePublishedArtifact, publishArtifact, type PublishRequest } from "../artifacts/publish.js";
import { promoteSessionArtifact } from "../artifacts/sessionScope.js";
import {
  ArtifactQueryError,
  listArtifacts,
  parseArtifactKindFilter,
  parseArtifactLimit,
  parseArtifactListOrder,
  parseArtifactListSort,
  parseArtifactLiveFilter,
  parseArtifactOwnerFilter,
  parseArtifactScope,
  parseArtifactStatus,
  parseArtifactTagFilter,
  parseArtifactTextQuery,
  readArtifact,
} from "../artifacts/query.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import { bindingQueryHttpStatus, queryBinding } from "../artifacts/bindingQuery.js";
import { refreshHttpStatus } from "../artifacts/refreshPolicy.js";
import { readArtifactSnapshots, refreshArtifact, type ArtifactRefreshDeps } from "../artifacts/refresh.js";
import { artifactVersionKind, listArtifactVersions, readArtifactVersionRow } from "../artifacts/versions.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_PUBLISH_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_POST_BODY_BYTES = 64 * 1024;

function sendError(
  json: Json,
  res: ServerResponse,
  error: ArtifactQueryError | ArtifactContentError | ArtifactPublishError,
): void {
  const projectRoots =
    error instanceof ArtifactQueryError || error instanceof ArtifactPublishError ? error.projectRoots : undefined;
  const issues = error instanceof ArtifactPublishError ? error.issues : undefined;
  const details = error instanceof ArtifactPublishError ? error.details : undefined;
  json(res, error.status, {
    error: error.message,
    code: error.code,
    ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
    ...(projectRoots !== undefined ? { project_roots: projectRoots } : {}),
    ...(details ?? {}),
  });
}

function sendContent(
  res: ServerResponse,
  bytes: Buffer,
  contentType: string,
  contentHash: string | null,
  kind: string,
): void {
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": bytes.length,
    "X-Content-Type-Options": "nosniff",
  };
  if (kind === "static.html" || kind === "live.html") {
    headers["Content-Security-Policy"] = STATIC_HTML_CONTENT_SECURITY_POLICY;
  }
  if (contentHash) headers["X-Artifact-Content-Hash"] = contentHash;
  res.writeHead(200, headers);
  res.end(bytes);
}

function parseVersionQuery(raw: string | null): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ArtifactQueryError(400, "artifact.invalid_shape", "version must be a positive integer");
  }
  return Number(raw);
}

async function readLimitedJson(req: IncomingMessage, maxBytes = MAX_PUBLISH_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    received += buffer.length;
    if (received > maxBytes) {
      throw new ArtifactPublishError(413, "artifact.too_large", "Request body is too large", [
        { path: "content", message: "request body is too large" },
      ]);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Request body is not JSON", [
      { path: "body", message: "must be JSON" },
    ]);
  }
}

function approveBody(raw: unknown): { originsHash: string; version?: number } {
  if (!isRecord(raw)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Request body must be an object", [
      { path: "body", message: "must be an object" },
    ]);
  }
  const allowed = new Set(["origins_hash", "version"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", `${key} is not a field`, [
        { path: key, message: "unknown field" },
      ]);
    }
  }
  if (typeof raw.origins_hash !== "string" || !/^[a-f0-9]{64}$/.test(raw.origins_hash)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "origins_hash is not valid", [
      { path: "origins_hash", message: "must be a sha256 hex digest" },
    ]);
  }
  let version: number | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "version")) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "version must be a positive integer", [
        { path: "version", message: "must be a positive integer" },
      ]);
    }
    version = raw.version;
  }
  return { originsHash: raw.origins_hash, ...(version !== undefined ? { version } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAX_BASE64_CHARS = Math.ceil(STATIC_CONTENT_MAX_BYTES / 3) * 4;

function invalidBase64(): never {
  throw new ArtifactPublishError(400, "artifact.invalid_shape", "content_base64 is not valid base64", [
    { path: "content_base64", message: "must be base64" },
  ]);
}

function base64TooLarge(): never {
  throw new ArtifactPublishError(
    413,
    "artifact.too_large",
    `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
    [{ path: "content_base64", message: `decoded content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
  );
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47
  );
}

export function decodeBase64(value: string): Buffer {
  if (value.length > MAX_BASE64_CHARS) base64TooLarge();
  if ((value.length & 3) !== 0) invalidBase64();
  const length = value.length;
  let pad = 0;
  if (length > 0 && value.charCodeAt(length - 1) === 61) {
    pad = 1;
    if (length > 1 && value.charCodeAt(length - 2) === 61) pad = 2;
  }
  if (pad === 2 && length > 2 && value.charCodeAt(length - 3) === 61) invalidBase64();
  const dataLength = length - pad;
  if (pad === 1 && (dataLength & 3) !== 3) invalidBase64();
  if (pad === 2 && (dataLength & 3) !== 2) invalidBase64();
  for (let i = 0; i < length; i++) {
    const code = value.charCodeAt(i);
    if (i >= dataLength) {
      if (code !== 61) invalidBase64();
      continue;
    }
    if (!isBase64Char(code)) invalidBase64();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > STATIC_CONTENT_MAX_BYTES) base64TooLarge();
  return decoded;
}

function ownerFromBody(value: unknown): ArtifactOwner {
  if (!isRecord(value)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "owner is required", [
      { path: "owner", message: "owner is required" },
    ]);
  }
  if (value.kind === "stage") {
    if (typeof value.pipeline !== "string" || typeof value.stage !== "string") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "stage owner requires pipeline and stage", [
        { path: "owner", message: "stage owner requires pipeline and stage" },
      ]);
    }
    return { kind: "stage", pipeline: value.pipeline, stage: value.stage };
  }
  if (value.kind === "agent") {
    if (typeof value.agent !== "string") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "agent owner requires agent", [
        { path: "owner", message: "agent owner requires agent" },
      ]);
    }
    return { kind: "agent", agent: value.agent };
  }
  throw new ArtifactPublishError(400, "artifact.invalid_shape", "owner.kind must be stage or agent", [
    { path: "owner.kind", message: "must be stage or agent" },
  ]);
}

function bytesFromBody(body: Record<string, unknown>): Buffer {
  const hasContent = Object.prototype.hasOwnProperty.call(body, "content");
  const hasBase64 = Object.prototype.hasOwnProperty.call(body, "content_base64");
  if (hasContent === hasBase64) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Send content or content_base64", [
      { path: "content", message: "send content or content_base64" },
    ]);
  }
  if (body.kind === "static.image" && !hasBase64) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Image content must be content_base64", [
      { path: "content_base64", message: "image content must be base64" },
    ]);
  }
  if (hasBase64) {
    if (typeof body.content_base64 !== "string") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "content_base64 must be a string", [
        { path: "content_base64", message: "must be a string" },
      ]);
    }
    return decodeBase64(body.content_base64);
  }
  if (typeof body.content !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "content must be a string", [
      { path: "content", message: "must be a string" },
    ]);
  }
  return Buffer.from(body.content, "utf8");
}

function optionalString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === null) return null;
  if (typeof body[key] !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", `${key} must be a string`, [
      { path: key, message: "must be a string" },
    ]);
  }
  return body[key] as string;
}

function publishRequestFromBody(
  body: unknown,
  roots: PublishRequest["roots"],
): PublishRequest {
  if (!isRecord(body)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Request body must be an object", [
      { path: "body", message: "must be an object" },
    ]);
  }
  const tags = body.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "tags must be an array of strings", [
      { path: "tags", message: "must be an array of strings" },
    ]);
  }
  if (typeof body.id !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_id", "id is required", [
      { path: "id", message: "id is required" },
    ]);
  }
  if (typeof body.kind !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_kind", "kind is required", [
      { path: "kind", message: "kind is required" },
    ]);
  }
  if (typeof body.title !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "title is required", [
      { path: "title", message: "title is required" },
    ]);
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "project_root") &&
    body.project_root !== undefined &&
    typeof body.project_root !== "string"
  ) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "project_root must be a string", [
      { path: "project_root", message: "must be a string" },
    ]);
  }
  return {
    owner: ownerFromBody(body.owner),
    projectRoot: typeof body.project_root === "string" ? body.project_root : undefined,
    id: body.id,
    kind: body.kind,
    title: body.title,
    description: optionalString(body, "description"),
    tags: tags as string[] | undefined,
    summary: optionalString(body, "summary"),
    bytes: bytesFromBody(body),
    ...(Object.prototype.hasOwnProperty.call(body, "manifest") ? { manifest: body.manifest } : {}),
    publishSource: body.source === "console" ? "console" : "api",
    roots,
  };
}

let refreshInvokeForTests: ArtifactRefreshDeps["invoke"] | undefined;

export function setArtifactRouteRefreshInvokeForTests(invoke: ArtifactRefreshDeps["invoke"] | undefined): void {
  refreshInvokeForTests = invoke;
}

function refreshRequestFromBody(body: unknown): { bindingIds?: string[]; ifStale?: boolean } {
  if (body === undefined || (isRecord(body) && Object.keys(body).length === 0)) return {};
  if (!isRecord(body)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Refresh body must be an object", [
      { path: "body", message: "must be an object" },
    ]);
  }
  for (const key of Object.keys(body)) {
    if (key !== "bindingIds" && key !== "ifStale") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "Refresh body has an unknown field", [
        { path: key, message: "is not a refresh field" },
      ]);
    }
  }
  let bindingIds: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "bindingIds")) {
    if (!Array.isArray(body.bindingIds) || body.bindingIds.some((id) => typeof id !== "string")) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "bindingIds must be an array of binding ids", [
        { path: "bindingIds", message: "must be an array of binding ids" },
      ]);
    }
    bindingIds = body.bindingIds as string[];
  }
  let ifStale: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "ifStale")) {
    if (typeof body.ifStale !== "boolean") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "ifStale must be a boolean", [
        { path: "ifStale", message: "must be a boolean" },
      ]);
    }
    ifStale = body.ifStale;
  }
  return {
    ...(bindingIds !== undefined ? { bindingIds } : {}),
    ...(ifStale !== undefined ? { ifStale } : {}),
  };
}

function queryRequestFromBody(body: unknown): { bindingId: string; args?: Record<string, unknown>; ifStale?: boolean } {
  if (!isRecord(body)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Query body must be an object", [
      { path: "body", message: "must be an object" },
    ]);
  }
  for (const key of Object.keys(body)) {
    if (key !== "binding_id" && key !== "args" && key !== "ifStale") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "Query body has an unknown field", [
        { path: key, message: "is not a query field" },
      ]);
    }
  }
  if (typeof body.binding_id !== "string" || body.binding_id.length === 0) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "binding_id is required", [
      { path: "binding_id", message: "is required" },
    ]);
  }
  let args: Record<string, unknown> | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "args")) {
    if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) {
      throw new ArtifactPublishError(400, "artifact.binding_args_invalid", "Binding arguments are not valid", [
        { path: "args", message: "must be an object" },
      ]);
    }
    args = body.args as Record<string, unknown>;
  }
  let ifStale: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "ifStale")) {
    if (typeof body.ifStale !== "boolean") {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "ifStale must be a boolean", [
        { path: "ifStale", message: "must be a boolean" },
      ]);
    }
    ifStale = body.ifStale;
  }
  return {
    bindingId: body.binding_id,
    ...(args !== undefined ? { args } : {}),
    ...(ifStale !== undefined ? { ifStale } : {}),
  };
}

function storageKeyFor(record: {
  id: string;
  project: { id: string };
  owner: ArtifactOwner;
}): string {
  return artifactStorageKey(record.project.id, artifactOwnerKey(record.owner), record.id);
}

function unexpectedFailure(method: string, pathname: string): { error: string; code: string } {
  if (method === "DELETE") return { error: "Delete failed", code: "artifact.delete_failed" };
  if (/\/refresh$/.test(pathname)) return { error: "Refresh failed", code: "artifact.refresh_failed" };
  if (/\/query$/.test(pathname)) return { error: "Query failed", code: "artifact.query_failed" };
  if (/\/promote$/.test(pathname)) return { error: "Promote failed", code: "artifact.promote_failed" };
  if (/\/origins\/(approve|revoke)$/.test(pathname)) return { error: "Origin approval failed", code: "artifact.approve_failed" };
  return { error: "Publish failed", code: "artifact.publish_failed" };
}

export async function handleArtifactRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  url: URL,
  store: RunStore,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const list = pathname === "/api/artifacts";
  const versions = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/versions$/.exec(pathname);
  const content = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/content$/.exec(pathname);
  const refresh = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/refresh$/.exec(pathname);
  const query = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/query$/.exec(pathname);
  const data = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/data$/.exec(pathname);
  const approve = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/origins\/approve$/.exec(pathname);
  const approval = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/origins\/approval$/.exec(pathname);
  const promote = /^\/api\/artifacts\/([^/]+)\/([^/]+)\/promote$/.exec(pathname);
  const record = /^\/api\/artifacts\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (
    !list &&
    versions === null &&
    content === null &&
    refresh === null &&
    query === null &&
    data === null &&
    approve === null &&
    approval === null &&
    promote === null &&
    record === null
  ) {
    return false;
  }
  if (list && method !== "GET" && method !== "POST") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  if (record && method !== "GET" && method !== "DELETE") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  if ((versions || content || data) && method !== "GET") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  if (promote && method !== "POST") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  if ((refresh || query || approve) && method !== "POST") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  if (approval && method !== "DELETE") {
    json(res, 405, { error: "Method not allowed", code: "artifact.invalid_shape" });
    return true;
  }
  const db = sqliteConnectionFromStore(store);
  if (db === undefined) {
    json(res, 503, { error: "Artifact index is unavailable", code: "artifact.store_unavailable" });
    return true;
  }
  try {
    const roots = await catalogRootsForArtifacts(store);
    if (list && method === "POST") {
      const request = publishRequestFromBody(await readLimitedJson(req), roots);
      const published = await publishArtifact(db, request);
      json(res, 200, published);
      return true;
    }
    if (list) {
      const page = listArtifacts(
        db,
        {
          projectRoot: url.searchParams.get("project_root") ?? undefined,
          limit: parseArtifactLimit(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor") ?? undefined,
          status: parseArtifactStatus(url.searchParams.get("status")),
          kind: parseArtifactKindFilter(url.searchParams.get("kind")),
          owner: parseArtifactOwnerFilter(url.searchParams.get("owner")),
          tag: parseArtifactTagFilter(url.searchParams.get("tag")),
          live: parseArtifactLiveFilter(url.searchParams.get("live")),
          sort: parseArtifactListSort(url.searchParams.get("sort")),
          order: parseArtifactListOrder(url.searchParams.get("order")),
          q: parseArtifactTextQuery(url.searchParams.get("q")),
          scope: parseArtifactScope(url.searchParams.get("scope")),
        },
        roots,
      );
      json(res, 200, page);
      return true;
    }
    const match = versions ?? content ?? refresh ?? query ?? data ?? approve ?? approval ?? promote ?? record;
    const ownerKey = decodeURIComponent(match![1]!);
    const id = decodeURIComponent(match![2]!);
    const projectRoot = url.searchParams.get("project_root") ?? undefined;
    if (approve || approval) {
      const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
      const storageKey = storageKeyFor(artifact);
      if (approve) {
        const body = approveBody(await readLimitedJson(req, MAX_LIVE_POST_BODY_BYTES));
        const approved = approveOrigins(db, storageKey, { ...body, by: "api" });
        json(res, 200, approved);
        return true;
      }
      const hash = url.searchParams.get("origins_hash");
      if (hash !== null && hash !== "" && !/^[a-f0-9]{64}$/.test(hash)) {
        throw new ArtifactPublishError(400, "artifact.invalid_shape", "origins_hash is not valid", [
          { path: "origins_hash", message: "must be a sha256 hex digest" },
        ]);
      }
      const revoked = revokeOrigins(db, storageKey, hash !== null && hash !== "" ? hash : undefined);
      json(res, 200, revoked);
      return true;
    }
    if (promote) {
      const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
      promoteSessionArtifact(db, storageKeyFor(artifact));
      json(res, 200, readArtifact(db, ownerKey, id, projectRoot, roots));
      return true;
    }
    if (record && method === "DELETE") {
      const deleted = await deletePublishedArtifact(db, ownerKey, id, projectRoot, roots);
      json(res, 200, deleted);
      return true;
    }
    const version = parseVersionQuery(url.searchParams.get("version"));
    if (versions) {
      const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
      json(res, 200, { versions: listArtifactVersions(db, storageKeyFor(artifact), artifact.version) });
      return true;
    }
    if (refresh || query || data) {
      const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
      const root = roots.find((item) => item.project_root === artifact.project.id);
      const storageKey = storageKeyFor(artifact);
      if (data) {
        json(res, 200, readArtifactSnapshots(db, storageKey));
        return true;
      }
      if (query) {
        const body = await readLimitedJson(req, MAX_LIVE_POST_BODY_BYTES);
        const request = queryRequestFromBody(body);
        const controller = new AbortController();
        const onClose = () => {
          if (res.writableFinished !== true) controller.abort();
        };
        if (typeof res.once === "function") res.once("close", onClose);
        const clientGone = () =>
          controller.signal.aborted || res.writableFinished === true || res.destroyed === true;
        try {
          const result = await queryBinding(
            db,
            {
              projectRoot: root?.path ?? artifact.project.id,
              projectId: artifact.project.id,
              ...(refreshInvokeForTests ? { invoke: refreshInvokeForTests } : {}),
            },
            storageKey,
            {
              bindingId: request.bindingId,
              ...(request.args !== undefined ? { args: request.args } : {}),
              ...(request.ifStale !== undefined ? { ifStale: request.ifStale } : {}),
              signal: controller.signal,
            },
          );
          if (clientGone()) return true;
          json(res, bindingQueryHttpStatus(result), result);
        } catch (error) {
          if (clientGone() || (error instanceof Error && error.name === "AbortError")) return true;
          throw error;
        } finally {
          if (typeof res.removeListener === "function") res.removeListener("close", onClose);
        }
        return true;
      }
      const body = await readLimitedJson(req, MAX_LIVE_POST_BODY_BYTES);
      const request = refreshRequestFromBody(body);
      const controller = new AbortController();
      const onClose = () => {
        if (res.writableFinished !== true) controller.abort();
      };
      if (typeof res.once === "function") res.once("close", onClose);
      const clientGone = () =>
        controller.signal.aborted || res.writableFinished === true || res.destroyed === true;
      try {
        const result = await refreshArtifact(
          db,
          {
            projectRoot: root?.path ?? artifact.project.id,
            projectId: artifact.project.id,
            ...(refreshInvokeForTests ? { invoke: refreshInvokeForTests } : {}),
          },
          storageKey,
          {
            ...(request.bindingIds !== undefined ? { bindingIds: request.bindingIds } : {}),
            ...(request.ifStale !== undefined ? { ifStale: request.ifStale } : {}),
            signal: controller.signal,
          },
        );
        if (clientGone()) return true;
        json(res, refreshHttpStatus(result), result);
      } catch (error) {
        if (clientGone() || (error instanceof Error && error.name === "AbortError")) return true;
        throw error;
      } finally {
        if (typeof res.removeListener === "function") res.removeListener("close", onClose);
      }
      return true;
    }
    if (content) {
      const body = await readArtifactContent(db, store, ownerKey, id, projectRoot, roots, version);
      sendContent(res, body.bytes, body.contentType, body.contentHash, body.kind);
      return true;
    }
    const artifact = readArtifact(db, ownerKey, id, projectRoot, roots);
    if (version === undefined) {
      json(res, 200, artifact);
      return true;
    }
    const row = readArtifactVersionRow(db, storageKeyFor(artifact), version);
    if (!row) {
      throw new ArtifactQueryError(404, "artifact.not_found", "Artifact version not found");
    }
    const versionKind = artifactVersionKind(row.manifest_json);
    const viewed = {
      ...artifact,
      version: row.version,
      size_bytes: row.size_bytes,
      content_type: row.content_type,
      content_hash: row.content_hash,
      ...(versionKind !== null ? { kind: versionKind } : {}),
    };
    if (versionKind !== null && isLiveKind(versionKind)) {
      const fields = artifactLiveManifestFields(versionKind, row.manifest_json);
      viewed.live = {
        status: artifact.live?.status ?? null,
        last_refreshed_at: artifact.live?.last_refreshed_at ?? null,
        last_error_code: artifact.live?.last_error_code ?? null,
        ...fields,
        ...(isLiveHtmlKind(versionKind)
          ? { origins: originApprovalView(db, storageKeyFor(artifact), fields.csp) }
          : {}),
      };
    } else if (versionKind !== null) {
      delete viewed.live;
    }
    json(res, 200, viewed);
    return true;
  } catch (error) {
    if (error instanceof URIError) {
      json(res, 400, { error: "Malformed path", code: "artifact.invalid_id" });
      return true;
    }
    if (
      error instanceof ArtifactQueryError ||
      error instanceof ArtifactContentError ||
      error instanceof ArtifactPublishError
    ) {
      sendError(json, res, error);
      return true;
    }
    if (method === "POST" || method === "DELETE") {
      console.error(
        `artifact ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const failure = unexpectedFailure(method, pathname);
      json(res, 500, { error: failure.error, code: failure.code });
      return true;
    }
    throw error;
  }
}
