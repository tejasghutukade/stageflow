import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import { EnvelopeError } from "../types/envelope.js";

export type ArtifactPresenceContext = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
};

type ArtifactInspectEvidence = {
  path: string;
  exists: boolean;
  file_type: "file" | "directory" | "symlink" | "other" | "missing";
};

function attemptArtifactsPrefix(stageId: string, attempt: number): string {
  return path.posix.join(
    "stages",
    stageId,
    "attempts",
    String(attempt),
    "artifacts",
  );
}

function missingArtifactMessage(listedPath: string): string {
  const basename = path.posix.basename(listedPath.replace(/\\/g, "/"));
  return `artifact "${basename}" is missing from this attempt's artifacts directory; write it with write_stage_artifact before emit`;
}

function notFileArtifactMessage(listedPath: string, fileType: string): string {
  const basename = path.posix.basename(listedPath.replace(/\\/g, "/"));
  return `artifact "${basename}" is ${fileType}, not a regular file under this attempt's artifacts directory; write it with write_stage_artifact before emit`;
}

/**
 * Map an envelope.artifacts entry to a path relative to the current attempt
 * artifacts directory. Foreign-stage / wrong-attempt run-relative paths and
 * escapes return undefined (fail closed).
 */
export function relativePathUnderAttemptArtifacts(
  listedPath: string,
  stageId: string,
  attempt: number,
): string | undefined {
  if (typeof listedPath !== "string" || listedPath.length === 0) {
    return undefined;
  }
  const posixListed = listedPath.replace(/\\/g, "/");
  if (path.isAbsolute(listedPath) || path.posix.isAbsolute(posixListed)) {
    return undefined;
  }

  const prefix = attemptArtifactsPrefix(stageId, attempt);
  if (posixListed === prefix || posixListed === `${prefix}/`) {
    return undefined;
  }
  if (posixListed.startsWith(`${prefix}/`)) {
    const relative = posixListed.slice(prefix.length + 1);
    return relative.length > 0 ? relative : undefined;
  }
  if (posixListed.startsWith("stages/")) {
    return undefined;
  }
  return posixListed;
}

async function inspectArtifact(
  artifactsDir: string,
  relativePath: string,
): Promise<ArtifactInspectEvidence> {
  const target = path.resolve(artifactsDir, relativePath);
  const relative = path.relative(artifactsDir, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { path: relativePath, exists: false, file_type: "missing" };
  }
  try {
    const segments = relative.split(path.sep).filter((segment) => segment !== "");
    let current = artifactsDir;
    let stats: Stats | undefined;
    for (const segment of segments) {
      current = path.join(current, segment);
      stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return { path: relativePath, exists: true, file_type: "symlink" };
      }
      if (current !== target && !stats.isDirectory()) {
        return { path: relativePath, exists: true, file_type: "other" };
      }
    }
    if (stats === undefined) {
      return { path: relativePath, exists: false, file_type: "missing" };
    }
    if (stats.isSymbolicLink()) {
      return { path: relativePath, exists: true, file_type: "symlink" };
    }
    if (stats.isDirectory()) {
      return { path: relativePath, exists: true, file_type: "directory" };
    }
    if (!stats.isFile()) {
      return { path: relativePath, exists: true, file_type: "other" };
    }
    return { path: relativePath, exists: true, file_type: "file" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relativePath, exists: false, file_type: "missing" };
    }
    throw error;
  }
}

/**
 * When `artifacts` is non-empty and attempt context is provided, each listed
 * path must resolve to an existing regular file under the current attempt
 * artifacts directory. Empty `artifacts` is a no-op. Distinct from emit-phase
 * `artifact_declared` (list-only) and after-phase `type: artifact` verify.
 */
export async function assertEmittedArtifactsOnDisk(
  artifacts: readonly string[],
  presence: ArtifactPresenceContext | undefined,
): Promise<void> {
  if (artifacts.length === 0 || presence === undefined) {
    return;
  }

  const artifactsDir = attemptArtifactsDir(
    presence.runWorkspaceDir,
    presence.stageId,
    presence.attempt,
  );

  for (const listed of artifacts) {
    const relative = relativePathUnderAttemptArtifacts(
      listed,
      presence.stageId,
      presence.attempt,
    );
    if (relative === undefined) {
      throw new EnvelopeError(missingArtifactMessage(listed));
    }
    const evidence = await inspectArtifact(artifactsDir, relative);
    if (evidence.file_type === "missing") {
      throw new EnvelopeError(missingArtifactMessage(listed));
    }
    if (evidence.file_type !== "file") {
      throw new EnvelopeError(notFileArtifactMessage(listed, evidence.file_type));
    }
  }
}
