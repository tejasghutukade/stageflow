import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ArtifactContentError, readArtifactContent, type ArtifactContentBody } from "../artifacts/content.js";
import { isLiveKind } from "../artifacts/kinds.js";
import { artifactStorageKey, stageOwnerKey } from "../artifacts/keys.js";
import { ArtifactPublishError } from "../artifacts/limits.js";
import { deletePublishedArtifact, publishArtifact, type PublishRequest } from "../artifacts/publish.js";
import { catalogRootsForArtifacts } from "../artifacts/projectScope.js";
import {
  ArtifactQueryError,
  listArtifacts,
  parseArtifactKindFilter,
  parseArtifactLimit,
  parseArtifactListOrder,
  parseArtifactListSort,
  parseArtifactLiveFilter,
  parseArtifactOwnerFilter,
  parseArtifactStatus,
  parseArtifactTagFilter,
  readArtifact,
  type ArtifactListQuery,
} from "../artifacts/query.js";
import { readArtifactSnapshots, refreshArtifact, type ArtifactSnapshotView } from "../artifacts/refresh.js";
import type { ArtifactRecord } from "../artifacts/record.js";
import { capUtf8 } from "../artifacts/search.js";
import { artifactVersionKind, listArtifactVersions, readArtifactVersionRow } from "../artifacts/versions.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";
import { decodeBase64 } from "../server/artifactRoutes.js";
import { parseArtifactShowKey } from "../cli/artifactListFormat.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export const MCP_TEXT_CONTENT_MAX_BYTES = 200 * 1024;
export const MCP_IMAGE_CONTENT_MAX_BYTES = 256 * 1024;

const getArtifactSchema = z.object({
  list: z.boolean().optional(),
  key: z.string().optional(),
  version: z.number().int().positive().optional(),
  view: z.enum(["record", "versions", "content", "data"]).optional(),
  kind: z.string().optional(),
  owner: z.string().optional(),
  tag: z.string().optional(),
  status: z.string().optional(),
  live: z.boolean().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.string().optional(),
  project_root: z.string().optional(),
  limit: z.number().int().optional(),
  cursor: z.string().optional(),
});

const saveArtifactSchema = z.object({
  owner: z.object({
    kind: z.enum(["stage", "agent"]),
    pipeline: z.string().optional(),
    stage: z.string().optional(),
    agent: z.string().optional(),
  }),
  project_root: z.string().optional(),
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().nullable().optional(),
  content: z.string().optional(),
  content_base64: z.string().optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
});

const deleteArtifactSchema = z.object({
  key: z.string(),
  project_root: z.string().optional(),
});

const refreshArtifactSchema = z.object({
  key: z.string(),
  project_root: z.string().optional(),
  binding_ids: z.array(z.string()).optional(),
});

export type McpArtifactSnapshot = ArtifactSnapshotView & {
  truncated?: boolean;
  size_bytes?: number;
};

export function capArtifactSnapshotsForMcp(snapshots: readonly ArtifactSnapshotView[]): {
  snapshots: McpArtifactSnapshot[];
  truncated: boolean;
} {
  const sized = snapshots.map((snapshot) => ({
    snapshot,
    size: Buffer.byteLength(JSON.stringify(snapshot.value ?? null), "utf8"),
  }));
  const dropped = new Set<number>();
  const render = (): McpArtifactSnapshot[] =>
    sized.map((entry, index) => {
      if (!dropped.has(index)) return { ...entry.snapshot };
      return { ...entry.snapshot, value: null, truncated: true, size_bytes: entry.size };
    });
  let rendered = render();
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(rendered), "utf8") > MCP_TEXT_CONTENT_MAX_BYTES) {
    let largest = -1;
    let largestSize = -1;
    for (let index = 0; index < sized.length; index += 1) {
      if (dropped.has(index)) continue;
      if (sized[index]!.size > largestSize) {
        largest = index;
        largestSize = sized[index]!.size;
      }
    }
    if (largest < 0) break;
    dropped.add(largest);
    truncated = true;
    rendered = render();
  }
  return { snapshots: rendered, truncated };
}

type ArtifactFailure = ArtifactQueryError | ArtifactContentError | ArtifactPublishError;

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

function failureResult(error: ArtifactFailure) {
  const projectRoots =
    error instanceof ArtifactQueryError || error instanceof ArtifactPublishError ? error.projectRoots : undefined;
  const issues = error instanceof ArtifactPublishError ? error.issues : undefined;
  return textResult(
    {
      error: error.message,
      code: error.code,
      status: error.status,
      ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
      ...(projectRoots !== undefined ? { project_roots: projectRoots } : {}),
    },
    true,
  );
}

function storageKeyFor(record: ArtifactRecord): string {
  const ownerKey =
    record.owner.kind === "agent"
      ? `agent:${record.owner.agent}`
      : stageOwnerKey(record.owner.pipeline, record.owner.stage);
  return artifactStorageKey(record.project.id, ownerKey, record.id);
}

function contentPayload(body: ArtifactContentBody) {
  const image = body.kind === "static.image" || body.contentType.startsWith("image/");
  if (image) {
    if (body.bytes.length > MCP_IMAGE_CONTENT_MAX_BYTES) {
      throw new ArtifactContentError(
        413,
        "artifact.content_too_large_for_mcp",
        "Image content is too large for MCP; use the console or CLI",
      );
    }
    return {
      kind: body.kind,
      content_type: body.contentType,
      size_bytes: body.bytes.length,
      content_hash: body.contentHash,
      base64: body.bytes.toString("base64"),
    };
  }
  const truncated = body.bytes.length > MCP_TEXT_CONTENT_MAX_BYTES;
  const slice = truncated ? capUtf8(body.bytes, MCP_TEXT_CONTENT_MAX_BYTES) : body.bytes;
  return {
    kind: body.kind,
    content_type: body.contentType,
    size_bytes: body.bytes.length,
    content_hash: body.contentHash,
    truncated,
    text: slice.toString("utf8"),
  };
}

function ownerFrom(value: z.infer<typeof saveArtifactSchema>["owner"]): PublishRequest["owner"] {
  if (value.kind === "stage") {
    if (value.pipeline === undefined || value.stage === undefined) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "stage owner requires pipeline and stage", [
        { path: "owner", message: "stage owner requires pipeline and stage" },
      ]);
    }
    return { kind: "stage", pipeline: value.pipeline, stage: value.stage };
  }
  if (value.agent === undefined) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "agent owner requires agent", [
      { path: "owner", message: "agent owner requires agent" },
    ]);
  }
  return { kind: "agent", agent: value.agent };
}

function bytesFrom(value: z.infer<typeof saveArtifactSchema>): Buffer {
  const hasContent = value.content !== undefined;
  const hasBase64 = value.content_base64 !== undefined;
  if (hasContent === hasBase64) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Send content or content_base64", [
      { path: "content", message: "send content or content_base64" },
    ]);
  }
  if (value.kind === "static.image" && !hasBase64) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "Image content must be content_base64", [
      { path: "content_base64", message: "image content must be base64" },
    ]);
  }
  if (hasBase64) return decodeBase64(value.content_base64!);
  return Buffer.from(value.content!, "utf8");
}

export function registerArtifactTools(server: McpServer, deps: McpToolDeps): void {
  const open = () => {
    const db = sqliteConnectionFromStore(deps.store);
    if (db === undefined) {
      throw new ArtifactQueryError(503, "artifact.store_unavailable", "Artifact index is unavailable");
    }
    return db;
  };

  server.registerTool(
    "get_artifact",
    {
      description: "List (list true) or read (key). view: record, versions, content, data.",
      inputSchema: getArtifactSchema,
    },
    async (args) => {
      const parsed = getArtifactSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const db = open();
        const roots = await catalogRootsForArtifacts(deps.store);
        if (value.list === true) {
          const needle = value.q?.trim() ?? "";
          const query: ArtifactListQuery = {
            projectRoot: value.project_root,
            limit: parseArtifactLimit(value.limit === undefined ? null : String(value.limit)),
            cursor: value.cursor,
            status: parseArtifactStatus(value.status ?? null),
            kind: parseArtifactKindFilter(value.kind ?? null),
            owner: parseArtifactOwnerFilter(value.owner ?? null),
            tag: parseArtifactTagFilter(value.tag ?? null),
            live: parseArtifactLiveFilter(value.live === undefined ? null : value.live ? "true" : "false"),
            sort: parseArtifactListSort(value.sort ?? null),
            order: parseArtifactListOrder(value.order ?? null),
            ...(needle.length > 0 ? { q: needle } : {}),
          };
          return textResult(listArtifacts(db, query, roots));
        }
        if (value.key === undefined) {
          return schemaError("Pass list true to list artifacts, or key to read one");
        }
        const parts = parseArtifactShowKey(value.key);
        if (parts === undefined) {
          throw new ArtifactQueryError(400, "artifact.invalid_id", "Artifact key must be <ownerKey>/<id>");
        }
        const view = value.view ?? "record";
        if (view === "data") {
          const artifact = readArtifact(db, parts.ownerKey, parts.id, value.project_root, roots);
          if (!isLiveKind(artifact.kind)) {
            throw new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live");
          }
          const data = readArtifactSnapshots(db, storageKeyFor(artifact));
          const capped = capArtifactSnapshotsForMcp(data.snapshots);
          return textResult({ ...data, snapshots: capped.snapshots, truncated: capped.truncated });
        }
        if (view === "versions") {
          const artifact = readArtifact(db, parts.ownerKey, parts.id, value.project_root, roots);
          return textResult({
            versions: listArtifactVersions(db, storageKeyFor(artifact), artifact.version),
          });
        }
        if (view === "content") {
          const body = await readArtifactContent(
            db,
            deps.store,
            parts.ownerKey,
            parts.id,
            value.project_root,
            roots,
            value.version,
          );
          return textResult(contentPayload(body));
        }
        const artifact = readArtifact(db, parts.ownerKey, parts.id, value.project_root, roots);
        if (value.version === undefined) return textResult(artifact);
        const row = readArtifactVersionRow(db, storageKeyFor(artifact), value.version);
        if (!row) throw new ArtifactQueryError(404, "artifact.not_found", "Artifact version not found");
        const versionKind = artifactVersionKind(row.manifest_json);
        return textResult({
          ...artifact,
          version: row.version,
          size_bytes: row.size_bytes,
          content_type: row.content_type,
          content_hash: row.content_hash,
          ...(versionKind !== null ? { kind: versionKind } : {}),
        });
      } catch (error) {
        if (
          error instanceof ArtifactQueryError ||
          error instanceof ArtifactContentError ||
          error instanceof ArtifactPublishError
        ) {
          return failureResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "save_artifact",
    {
      description: "Publish an artifact; live.declarative or live.html needs manifest. Same bytes keep the version.",
      inputSchema: saveArtifactSchema,
    },
    async (args) => {
      const parsed = saveArtifactSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const db = open();
        const roots = await catalogRootsForArtifacts(deps.store);
        const published = await publishArtifact(db, {
          owner: ownerFrom(value.owner),
          projectRoot: value.project_root,
          id: value.id,
          kind: value.kind,
          title: value.title,
          description: value.description,
          tags: value.tags,
          summary: value.summary,
          bytes: bytesFrom(value),
          ...(value.manifest !== undefined ? { manifest: value.manifest } : {}),
          publishSource: "api",
          source: { kind: "mcp" },
          roots,
        });
        return textResult({
          key: published.key,
          version: published.version,
          unchanged: published.unchanged,
          project_root: published.project_root,
          ...(published.agent_unverified ? { agent_unverified: true } : {}),
          ...(published.warnings && published.warnings.length > 0 ? { warnings: published.warnings } : {}),
        });
      } catch (error) {
        if (
          error instanceof ArtifactQueryError ||
          error instanceof ArtifactContentError ||
          error instanceof ArtifactPublishError
        ) {
          return failureResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "refresh_artifact",
    {
      description: "Refresh a live artifact.",
      inputSchema: refreshArtifactSchema,
    },
    async (args) => {
      const parsed = refreshArtifactSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const parts = parseArtifactShowKey(value.key);
        if (parts === undefined) {
          throw new ArtifactQueryError(400, "artifact.invalid_id", "Artifact key must be <ownerKey>/<id>");
        }
        const db = open();
        const roots = await catalogRootsForArtifacts(deps.store);
        const artifact = readArtifact(db, parts.ownerKey, parts.id, value.project_root, roots);
        if (!isLiveKind(artifact.kind)) {
          throw new ArtifactQueryError(404, "artifact.not_live", "Artifact is not live");
        }
        const root = roots.find((item) => item.project_root === artifact.project.id);
        const result = await refreshArtifact(
          db,
          { projectRoot: root?.path ?? artifact.project.id, projectId: artifact.project.id },
          storageKeyFor(artifact),
          {
            ...(value.binding_ids !== undefined ? { bindingIds: value.binding_ids } : {}),
            bindingIdsIssuePath: "binding_ids",
          },
        );
        const capped = capArtifactSnapshotsForMcp(result.snapshots);
        return textResult({ ...result, snapshots: capped.snapshots, truncated: capped.truncated });
      } catch (error) {
        if (
          error instanceof ArtifactQueryError ||
          error instanceof ArtifactContentError ||
          error instanceof ArtifactPublishError
        ) {
          return failureResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "delete_artifact",
    {
      description: "Delete a published artifact. Indexed artifacts are refused.",
      inputSchema: deleteArtifactSchema,
    },
    async (args) => {
      const parsed = deleteArtifactSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const parts = parseArtifactShowKey(value.key);
        if (parts === undefined) {
          throw new ArtifactQueryError(400, "artifact.invalid_id", "Artifact key must be <ownerKey>/<id>");
        }
        const db = open();
        const roots = await catalogRootsForArtifacts(deps.store);
        const deleted = await deletePublishedArtifact(db, parts.ownerKey, parts.id, value.project_root, roots);
        return textResult(deleted);
      } catch (error) {
        if (
          error instanceof ArtifactQueryError ||
          error instanceof ArtifactContentError ||
          error instanceof ArtifactPublishError
        ) {
          return failureResult(error);
        }
        throw error;
      }
    },
  );
}
