import * as fs from "node:fs";
import { Type } from "typebox";
import { scrubSecrets } from "../compaction/scrub.js";
import { inspectArtifactUnderRoot } from "../runtime/artifactDiskInspect.js";
import { acceptArtifactListedPath } from "../runtime/artifactPath.js";
import { PATH_DENIED_MESSAGE } from "../runread/readArtifact.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import {
  ARTIFACT_DESCRIPTION_MAX_CHARS,
  ARTIFACT_SUMMARY_MAX_CHARS,
  ARTIFACT_TAG_MAX,
  ARTIFACT_TITLE_MAX_CHARS,
  STATIC_CONTENT_MAX_BYTES,
  ArtifactPublishError,
  type ArtifactIssue,
} from "../artifacts/limits.js";
import type { StaticArtifactKind } from "../artifacts/kinds.js";
import { SessionPublishError, type SessionPublishBody, type SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import { PUBLISH_ARTIFACT_TOOL_NAME } from "./stageToolNames.js";

export const STATIC_KINDS = [
  "static.markdown",
  "static.image",
  "static.table",
  "static.text",
  "static.html",
] as const satisfies readonly StaticArtifactKind[];

export type PublishArtifactCaller = (body: SessionPublishBody) => Promise<SessionPublishSuccess>;

export type PublishArtifactToolOptions = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
  publish: PublishArtifactCaller;
};

function toolError(code: string, message: string, issues?: ArtifactIssue[]) {
  const payload = {
    code,
    message: scrubSecrets(message),
    ...(issues !== undefined
      ? { issues: issues.map((issue) => ({ path: issue.path, message: scrubSecrets(issue.message) })) }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true as const,
  };
}

function toolOk(result: SessionPublishSuccess) {
  const payload: { key: string; version: number; unchanged?: true; url?: string } = {
    key: result.key,
    version: result.version,
  };
  if (result.unchanged) payload.unchanged = true;
  if (result.url) payload.url = result.url;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

export function artifactPublishPromptSection(expect?: readonly string[]): string {
  const mib = Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024));
  const lines = [
    "# Published artifacts",
    "",
    "Use publish_artifact for a final deliverable a person should open later. Skip scratch notes, logs, and intermediate files.",
    "",
    "The id is a lowercase slug: it starts with a letter, then has up to 63 letters, digits, underscores, or hyphens (`^[a-z][a-z0-9_-]{0,63}$`). Publishing the same id again creates a new version. If the bytes and kind are unchanged, the current version is kept and the tool returns unchanged. That unchanged publish still counts for this attempt.",
    "",
    `Kinds: ${STATIC_KINDS.join(", ")}. Content is at most ${mib} MiB. The title is at most ${ARTIFACT_TITLE_MAX_CHARS} characters. You may set at most ${ARTIFACT_TAG_MAX} tags, each matching [a-z0-9_-] and at most 32 characters. Description and summary are at most ${ARTIFACT_DESCRIPTION_MAX_CHARS} and ${ARTIFACT_SUMMARY_MAX_CHARS} characters.`,
    "",
    "Give path, content, or content_base64, and only one of them. path is a run-relative path inside this attempt's artifacts directory, or a path relative to that directory. content is inline text. content_base64 is an image (png, jpeg, gif, or webp).",
    "",
    "Files you list on the success envelope are indexed automatically. publish_artifact is different: it stores a titled, versioned artifact that remains after the run.",
  ];
  if (expect !== undefined && expect.length > 0) {
    lines.push("", `Before a success envelope, publish every id in this list: ${expect.join(", ")}.`);
  }
  return lines.join("\n");
}

export function appendArtifactPublishPrompt(
  systemPrompt: string,
  expect?: readonly string[],
  enabled = false,
): string {
  if (!enabled) return systemPrompt;
  return `${systemPrompt}\n\n${artifactPublishPromptSection(expect)}`;
}

let publishPathBytesRead = 0;
let beforePublishFileOpen: (() => void) | undefined;

export function publishPathBytesReadForTests(): number {
  return publishPathBytesRead;
}

export function resetPublishPathBytesReadForTests(): void {
  publishPathBytesRead = 0;
}

export function setPublishFileOpenHookForTests(hook: (() => void) | undefined): void {
  beforePublishFileOpen = hook;
}

const ARTIFACT_MESSAGES = {
  relativeRequired: PATH_DENIED_MESSAGE,
  escapes: PATH_DENIED_MESSAGE,
  notFound: (relativePath: string) => `Artifact not found: ${relativePath}`,
  denied: PATH_DENIED_MESSAGE,
};

async function readArtifactPath(
  options: PublishArtifactToolOptions,
  rawPath: string,
): Promise<Buffer> {
  const accepted = acceptArtifactListedPath(rawPath, {
    kind: "current_attempt",
    stageId: options.stageId,
    attempt: options.attempt,
  });
  if (!accepted || accepted.stageId !== options.stageId || accepted.attempt !== options.attempt) {
    throw new ArtifactPublishError(403, "artifact.invalid_shape", PATH_DENIED_MESSAGE, [
      { path: "path", message: PATH_DENIED_MESSAGE },
    ]);
  }
  if (accepted.relative.split(/[/\\]/).some((segment) => segment === ".." || segment === ".")) {
    throw new ArtifactPublishError(403, "artifact.invalid_shape", PATH_DENIED_MESSAGE, [
      { path: "path", message: PATH_DENIED_MESSAGE },
    ]);
  }
  const artifactsDir = attemptArtifactsDir(options.runWorkspaceDir, options.stageId, options.attempt);
  const presence = await inspectArtifactUnderRoot(artifactsDir, accepted.relative);
  if (presence.file_type === "missing") {
    const message = ARTIFACT_MESSAGES.notFound(accepted.relative);
    throw new ArtifactPublishError(404, "artifact.not_found", message, [{ path: "path", message }]);
  }
  if (presence.file_type !== "file" || presence.absolutePath === undefined) {
    throw new ArtifactPublishError(403, "artifact.invalid_shape", PATH_DENIED_MESSAGE, [
      { path: "path", message: PATH_DENIED_MESSAGE },
    ]);
  }
  if ((presence.size_bytes ?? 0) > STATIC_CONTENT_MAX_BYTES) {
    throw new ArtifactPublishError(
      413,
      "artifact.too_large",
      `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes`,
      [{ path: "path", message: `content is larger than ${STATIC_CONTENT_MAX_BYTES} bytes` }],
    );
  }
  return readCappedPublishFile(presence.absolutePath, STATIC_CONTENT_MAX_BYTES);
}

function denyPublishPath(): never {
  throw new ArtifactPublishError(403, "artifact.invalid_shape", PATH_DENIED_MESSAGE, [
    { path: "path", message: PATH_DENIED_MESSAGE },
  ]);
}

function publishTooLarge(cap: number): never {
  throw new ArtifactPublishError(413, "artifact.too_large", `content is larger than ${cap} bytes`, [
    { path: "path", message: `content is larger than ${cap} bytes` },
  ]);
}

export function readCappedPublishFile(file: string, cap: number): Buffer {
  let listed: fs.Stats;
  try {
    listed = fs.lstatSync(file);
  } catch {
    denyPublishPath();
  }
  if (listed.isFile() && listed.size > cap) publishTooLarge(cap);
  beforePublishFileOpen?.();
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    denyPublishPath();
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) denyPublishPath();
    if (stat.size > cap) publishTooLarge(cap);
    const buf = Buffer.alloc(cap + 1);
    const bytesRead = fs.readSync(fd, buf, 0, cap + 1, 0);
    publishPathBytesRead += bytesRead;
    if (bytesRead > cap) publishTooLarge(cap);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

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
      kind: Type.Union(STATIC_KINDS.map((kind) => Type.Literal(kind)) as [
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
    },
    { additionalProperties: false },
  );
}

export function createPublishArtifactTool(options: PublishArtifactToolOptions) {
  return {
    name: PUBLISH_ARTIFACT_TOOL_NAME,
    label: "Publish artifact",
    description: `Publish a titled, versioned artifact a person can open later. Kinds: ${STATIC_KINDS.join(", ")}. Content at most ${Math.floor(STATIC_CONTENT_MAX_BYTES / (1024 * 1024))} MiB. Pass path (inside this attempt's artifacts directory), content, or content_base64. Publishing the same id again creates a new version. This call does not end the turn. A validation error returns a code and issues; fix the arguments and call again.`,
    parameters: publishArtifactParameterSchema(),
    execute: async (_toolCallId: string, params: unknown): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
      isError?: true;
    }> => {
      try {
        const body = await publishBodyFromToolParams(params, (rawPath) => readArtifactPath(options, rawPath));
        const result = await options.publish(body);
        return toolOk(result);
      } catch (error) {
        if (error instanceof ArtifactPublishError || error instanceof SessionPublishError) {
          return toolError(error.code, error.message, error.issues);
        }
        return toolError("artifact.invalid_shape", "artifact publish failed");
      }
    },
  };
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
  if (!(STATIC_KINDS as readonly string[]).includes(record.kind)) {
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
  return {
    id: record.id,
    kind: record.kind,
    title: scrubSecrets(record.title),
    ...(typeof record.description === "string" ? { description: scrubSecrets(record.description) } : {}),
    ...(tags !== undefined ? { tags: (tags as string[]).map((tag) => scrubSecrets(tag)) } : {}),
    ...(typeof record.summary === "string" ? { summary: scrubSecrets(record.summary) } : {}),
    bytes,
  };
}
