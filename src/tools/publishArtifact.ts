import * as fs from "node:fs";
import { inspectArtifactUnderRoot } from "../runtime/artifactDiskInspect.js";
import { acceptArtifactListedPath } from "../runtime/artifactPath.js";
import { PATH_DENIED_MESSAGE } from "../runread/readArtifact.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import { STATIC_CONTENT_MAX_BYTES, ArtifactPublishError } from "../artifacts/limits.js";
import type { SessionPublishBody, SessionPublishSuccess } from "../artifacts/sessionPublish.js";
import type { BindableFunctionInfo } from "../artifacts/bindable.js";
import { toPiTool } from "../genui/adapters/pi.js";
import { genUiPublishPrompt } from "../genui/prompt.js";
import { publishOnlyPolicy, surfaceKey } from "../genui/surface.js";
import { publishArtifactSpec } from "../genui/tools.js";
import { PUBLISH_KINDS } from "../genui/kindsList.js";

export type PublishArtifactCaller = (body: SessionPublishBody) => Promise<SessionPublishSuccess>;

export type PublishArtifactToolOptions = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
  publish: PublishArtifactCaller;
};

export function appendArtifactPublishPrompt(
  systemPrompt: string,
  expect?: readonly string[],
  enabled = false,
  functions?: readonly BindableFunctionInfo[],
): string {
  if (!enabled) return systemPrompt;
  return `${systemPrompt}\n\n${genUiPublishPrompt({ publisher: "stage", ...(expect ? { expect } : {}), ...(functions ? { functions } : {}) })}`;
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

/** publish_artifact for a stage attempt: paths resolve inside this attempt's artifacts directory. */
export function createPublishArtifactTool(options: PublishArtifactToolOptions) {
  const id = `${options.stageId}#${options.attempt}`;
  return toPiTool(publishArtifactSpec("stage"), {
    key: surfaceKey("stage", id),
    id,
    projectRoot: options.runWorkspaceDir,
    policy: publishOnlyPolicy(PUBLISH_KINDS),
    publish: { readPath: (rawPath) => readArtifactPath(options, rawPath), publish: options.publish },
  });
}
