import path from "node:path";
import { acceptArtifactListedPath } from "../runtime/artifactPath.js";
import { inspectArtifactUnderRoot } from "../runtime/artifactDiskInspect.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import { EnvelopeError } from "../types/envelope.js";

export type ArtifactPresenceContext = {
  runWorkspaceDir: string;
  stageId: string;
  attempt: number;
};

function artifactBasename(listedPath: string): string {
  return path.posix.basename(listedPath.replace(/\\/g, "/"));
}

function missingArtifactMessage(listedPath: string): string {
  return `artifact "${artifactBasename(listedPath)}" is missing from this attempt's artifacts directory; write it with write_stage_artifact before emit`;
}

function notFileArtifactMessage(listedPath: string, fileType: string): string {
  return `artifact "${artifactBasename(listedPath)}" is ${fileType}, not a regular file under this attempt's artifacts directory; write it with write_stage_artifact before emit`;
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
    const accepted = acceptArtifactListedPath(listed, {
      kind: "current_attempt",
      stageId: presence.stageId,
      attempt: presence.attempt,
    });
    if (accepted === undefined) {
      throw new EnvelopeError(missingArtifactMessage(listed));
    }
    const disk = await inspectArtifactUnderRoot(artifactsDir, accepted.relative);
    if (disk.file_type === "missing") {
      throw new EnvelopeError(missingArtifactMessage(listed));
    }
    if (disk.file_type !== "file") {
      throw new EnvelopeError(notFileArtifactMessage(listed, disk.file_type));
    }
  }
}
