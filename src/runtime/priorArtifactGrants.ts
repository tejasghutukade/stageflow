import { realpath } from "node:fs/promises";
import path from "node:path";
import type { TerminalEnvelope } from "../types/envelope.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";
import {
  acceptArtifactListedPath,
  isGrantableArtifactPath,
} from "./artifactPath.js";
import { inspectArtifactUnderRoot } from "./artifactDiskInspect.js";
import type { ResolvePriorEnvelopeResult } from "./envelopeRouting.js";
import { SANDBOX_MOUNT_PATH } from "./sandboxContainer.js";
import type { StageArtifactGrant } from "./stageRoots.js";

export { isGrantableArtifactPath } from "./artifactPath.js";

function successArtifactsFromPrior(
  prior: Extract<ResolvePriorEnvelopeResult, { ok: true }>,
): string[] {
  const envelopes: TerminalEnvelope[] = [];
  if (prior.prior !== null && prior.prior !== undefined) {
    envelopes.push(prior.prior);
  }
  if (prior.joinPriors !== undefined) {
    envelopes.push(...prior.joinPriors);
  }
  if (prior.priorEnvelopesByStage !== undefined) {
    for (const value of Object.values(prior.priorEnvelopesByStage)) {
      if (Array.isArray(value)) envelopes.push(...value);
      else envelopes.push(value);
    }
  }
  const listed: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.status !== "success") continue;
    listed.push(...envelope.artifacts);
  }
  return listed;
}

/**
 * Soft-skip grant host resolution: missing / symlink / non-file → null.
 * Closed-posture walk via inspect; realpath must stay inside the workspace.
 */
async function resolveGrantableHostFile(
  workspaceRoot: string,
  listedPath: string,
): Promise<string | null> {
  try {
    const presence = await inspectArtifactUnderRoot(workspaceRoot, listedPath);
    if (presence.file_type !== "file" || presence.absolutePath === undefined) {
      return null;
    }
    const current = presence.absolutePath;
    if (!isInsideDir(current, workspaceRoot) || current === workspaceRoot) {
      return null;
    }
    const workspaceReal = await realpath(workspaceRoot);
    const fileReal = await realpath(current);
    if (!isInsideDir(fileReal, workspaceReal) || fileReal === workspaceReal) {
      return null;
    }
    return current;
  } catch {
    return null;
  }
}

/** Sandbox path for one artifact. Colliding names from different attempts include the attempt. */
export function assignGrantContainerPaths(listedPaths: readonly string[]): Map<string, string> {
  const parsed = listedPaths.map((listedPath) => {
    const parts = acceptArtifactListedPath(listedPath, { kind: "grantable" });
    const base =
      parts === undefined
        ? null
        : `${SANDBOX_MOUNT_PATH}/grants/${parts.stageId}/${parts.relative}`;
    return { listedPath, parts, base };
  });
  const counts = new Map<string, number>();
  for (const item of parsed) {
    if (item.base === null) continue;
    counts.set(item.base, (counts.get(item.base) ?? 0) + 1);
  }
  const assigned = new Map<string, string>();
  for (const item of parsed) {
    if (item.parts === undefined || item.base === null) continue;
    const containerPath =
      (counts.get(item.base) ?? 0) > 1
        ? `${SANDBOX_MOUNT_PATH}/grants/${item.parts.stageId}/attempt-${item.parts.attempt}/${item.parts.relative}`
        : item.base;
    assigned.set(item.listedPath, containerPath);
  }
  return assigned;
}

export async function artifactGrantsFromPriors(
  workspaceDir: string,
  prior: Extract<ResolvePriorEnvelopeResult, { ok: true }>,
): Promise<StageArtifactGrant[]> {
  const workspaceRoot = path.resolve(workspaceDir);
  const listed = successArtifactsFromPrior(prior).filter(isGrantableArtifactPath);
  const containerPaths = assignGrantContainerPaths(listed);
  const grants: StageArtifactGrant[] = [];
  const seen = new Set<string>();

  for (const listedPath of listed) {
    const containerPath = containerPaths.get(listedPath);
    if (containerPath === undefined) continue;
    const hostPath = await resolveGrantableHostFile(workspaceRoot, listedPath);
    if (hostPath === null || seen.has(hostPath)) continue;
    seen.add(hostPath);
    grants.push({
      listedPath,
      hostPath,
      containerPath,
      kind: "file",
    });
  }

  return grants;
}
