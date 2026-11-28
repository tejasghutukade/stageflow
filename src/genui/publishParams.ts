import { Type } from "typebox";
import { scrubSecrets } from "../compaction/scrub.js";
import { LIVE_DECLARATIVE_KIND, LIVE_HTML_KIND } from "../artifacts/kinds.js";
import { LIVE_HTML_MAX_BYTES, LIVE_PROGRAM_MAX_BYTES, STATIC_CONTENT_MAX_BYTES, ArtifactPublishError } from "../artifacts/limits.js";
import type { SessionPublishBody } from "../artifacts/sessionPublish.js";
import { PUBLISH_KINDS } from "./kindsList.js";

function utf8Text(bytes: Buffer, issuePath: "path" | "content"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "content is not valid UTF-8", [
      { path: issuePath, message: "content is not valid UTF-8" },
    ]);
  }
}

function scrubPublishBytes(bytes: Buffer, kind: string, issuePath: "path" | "content"): Buffer {
  if (kind === "static.image") return bytes;
  return Buffer.from(scrubSecrets(utf8Text(bytes, issuePath)), "utf8");
}

export function publishArtifactParameterSchema() {
  return Type.Object(
    {
      id: Type.String({ minLength: 1 }),
      kind: Type.Union(PUBLISH_KINDS.map((kind) => Type.Literal(kind)) as [
        ReturnType<typeof Type.Literal>,
        ReturnType<typeof Type.Literal>,
        ...ReturnType<typeof Type.Literal>[],
      ]),
      title: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      summary: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      content_base64: Type.Optional(Type.String()),
      format: Type.Optional(Type.String()),
      library: Type.Optional(Type.Object({ name: Type.String(), version: Type.String() })),
      bindings: Type.Optional(
        Type.Array(Type.Object({ id: Type.String(), function: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) })),
      ),
      refresh: Type.Optional(
        Type.Object({
          on_view: Type.Optional(Type.Boolean()),
          ttl_seconds: Type.Optional(Type.Integer()),
          auto_seconds: Type.Optional(Type.Integer()),
        }),
      ),
      csp: Type.Optional(
        Type.Object({
          connectDomains: Type.Optional(Type.Array(Type.String())),
          resourceDomains: Type.Optional(Type.Array(Type.String())),
          frameDomains: Type.Optional(Type.Array(Type.String())),
          baseUriDomains: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      libraries: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            version: Type.String(),
            allowEval: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
    },
    { additionalProperties: false },
  );
}

export async function publishBodyFromToolParams(
  params: unknown,
  readPath: (rawPath: string) => Promise<Buffer>,
): Promise<SessionPublishBody> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "parameters must be an object", [
      { path: "", message: "parameters must be an object" },
    ]);
  }
  const record = params as Record<string, unknown>;
  const sources = [record.path, record.content, record.content_base64].filter((value) => value !== undefined);
  if (sources.length !== 1) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "pass one of path, content, or content_base64", [
      { path: "content", message: "pass one of path, content, or content_base64" },
    ]);
  }
  if (typeof record.id !== "string" || typeof record.kind !== "string" || typeof record.title !== "string") {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "id, kind, and title are required", [
      { path: "id", message: "id, kind, and title are required" },
    ]);
  }
  if (!(PUBLISH_KINDS as readonly string[]).includes(record.kind)) {
    throw new ArtifactPublishError(400, "artifact.invalid_kind", `Unsupported artifact kind: ${record.kind}`, [
      { path: "kind", message: `Unsupported artifact kind: ${record.kind}` },
    ]);
  }
  let bytes: Buffer;
  let bytePath: "path" | "content" = "content";
  if (typeof record.path === "string") {
    bytes = await readPath(record.path);
    bytePath = "path";
  } else if (typeof record.content === "string") {
    if (Buffer.byteLength(record.content, "utf8") > STATIC_CONTENT_MAX_BYTES) {
      throw new ArtifactPublishError(
        413,
        "artifact.too_large",
        `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
        [{ path: "content", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
      );
    }
    bytes = Buffer.from(record.content, "utf8");
  } else if (typeof record.content_base64 === "string") {
    if (record.content_base64.length > Math.ceil(STATIC_CONTENT_MAX_BYTES / 3) * 4) {
      throw new ArtifactPublishError(
        413,
        "artifact.too_large",
        `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
        [{ path: "content_base64", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
      );
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(record.content_base64) || record.content_base64.length % 4 !== 0) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "content_base64 is not valid base64", [
        { path: "content_base64", message: "must be standard base64 with no whitespace" },
      ]);
    }
    bytes = Buffer.from(record.content_base64, "base64");
    if (bytes.length > STATIC_CONTENT_MAX_BYTES) {
      throw new ArtifactPublishError(
        413,
        "artifact.too_large",
        `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
        [{ path: "content_base64", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
      );
    }
  } else {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "pass one of path, content, or content_base64", [
      { path: "content", message: "pass one of path, content, or content_base64" },
    ]);
  }
  bytes = scrubPublishBytes(bytes, record.kind, bytePath);
  const tags = record.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "tags must be an array of strings", [
      { path: "tags", message: "tags must be an array of strings" },
    ]);
  }
  const cap =
    record.kind === LIVE_DECLARATIVE_KIND
      ? LIVE_PROGRAM_MAX_BYTES
      : record.kind === LIVE_HTML_KIND
        ? LIVE_HTML_MAX_BYTES
        : STATIC_CONTENT_MAX_BYTES;
  if (bytes.length > cap) {
    throw new ArtifactPublishError(413, "artifact.too_large", `content is larger than ${cap} bytes`, [
      { path: bytePath, message: `content is larger than ${cap} bytes` },
    ]);
  }
  return {
    id: record.id,
    kind: record.kind,
    title: scrubSecrets(record.title),
    ...(typeof record.description === "string" ? { description: scrubSecrets(record.description) } : {}),
    ...(tags !== undefined ? { tags: (tags as string[]).map((tag) => scrubSecrets(tag)) } : {}),
    ...(typeof record.summary === "string" ? { summary: scrubSecrets(record.summary) } : {}),
    bytes,
    ...liveManifestFields(record),
  };
}

function liveManifestFields(record: Record<string, unknown>): { manifest?: unknown } {
  const liveFields = ["format", "library", "bindings", "refresh", "csp", "libraries"] as const;
  const present = liveFields.some((key) => record[key] !== undefined);
  if (record.kind !== LIVE_HTML_KIND && record.libraries !== undefined) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "libraries is only valid for live.html", [
      { path: "libraries", message: "libraries is only valid for live.html" },
    ]);
  }
  if (record.kind === LIVE_HTML_KIND) {
    if (record.library !== undefined) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "library is not valid for live.html", [
        { path: "library", message: "library is not valid for live.html" },
      ]);
    }
    return {
      manifest: {
        format: record.format ?? "html",
        ...(record.csp !== undefined ? { csp: record.csp } : {}),
        ...(record.libraries !== undefined ? { libraries: record.libraries } : {}),
        bindings: record.bindings ?? [],
        ...(record.refresh !== undefined ? { refresh: record.refresh } : {}),
      },
    };
  }
  if (record.kind !== LIVE_DECLARATIVE_KIND) {
    if (present) {
      throw new ArtifactPublishError(400, "artifact.invalid_shape", "bindings and refresh are only valid for a live artifact", [
        { path: "bindings", message: "bindings and refresh are only valid for a live artifact" },
      ]);
    }
    return {};
  }
  if (record.csp !== undefined) {
    throw new ArtifactPublishError(400, "artifact.invalid_shape", "csp is only valid for live.html", [
      { path: "csp", message: "csp is only valid for live.html" },
    ]);
  }
  return {
    manifest: {
      format: record.format,
      library: record.library,
      bindings: record.bindings ?? [],
      ...(record.refresh !== undefined ? { refresh: record.refresh } : {}),
    },
  };
}
