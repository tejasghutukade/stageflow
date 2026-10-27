import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { TerminalEnvelope } from "../types/envelope.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";
import type { ResolvePriorEnvelopeResult } from "./envelopeRouting.js";
import { SANDBOX_MOUNT_PATH } from "./sandboxContainer.js";
import type { StageArtifactGrant } from "./stageRoots.js";

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

export function isGrantableArtifactPath(listedPath: string): boolean {
  if (typeof listedPath !== "string" || listedPath.length === 0) return false;
  const posix = listedPath.replace(/\\/g, "/");
  if (path.isAbsolute(listedPath) || path.posix.isAbsolute(posix)) return false;
  if (posix.includes("\0") || posix.includes("..")) return false;
  const parts = posix.split("/").filter((part) => part.length > 0);
  if (parts.length < 6) return false;
  if (parts[0] !== "stages" || parts[2] !== "attempts" || parts[4] !== "artifacts") {
    return false;
  }
  const attempt = parts[3]!;
  if (!/^\d+$/.test(attempt)) return false;
  return true;
}

/**
 * Walk listedPath under workspaceRoot with lstat on every segment.
 * Rejects any symlink ancestor or leaf (same closed posture as emit disk-truth).
 * Returns the absolute lexical path only when the leaf is a regular file.
 */
async function resolveGrantableHostFile(
  workspaceRoot: string,
  listedPath: string,
): Promise<string | null> {
  const posix = listedPath.replace(/\\/g, "/");
  const segments = posix.split("/").filter((segment) => segment.length > 0);
  let current = workspaceRoot;
  let stats: Stats | undefined;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!isInsideDir(current, workspaceRoot) || current === workspaceRoot) {
      return null;
    }
    try {
      stats = await lstat(current);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink()) {
      return null;
    }
  }
  if (stats === undefined || !stats.isFile()) {
    return null;
  }
  try {
    const workspaceReal = await realpath(workspaceRoot);
    const fileReal = await realpath(current);
    if (!isInsideDir(fileReal, workspaceReal) || fileReal === workspaceReal) {
      return null;
    }
  } catch {
    return null;
  }
  return current;
}

type ParsedArtifactPath = {
  stageId: string;
  attempt: string;
  relative: string;
};

function parseGrantableArtifact(listedPath: string): ParsedArtifactPath | null {
  if (!isGrantableArtifactPath(listedPath)) return null;
  const parts = listedPath.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
  return {
    stageId: parts[1]!,
    attempt: parts[3]!,
    relative: parts.slice(5).join("/"),
  };
}

/** Sandbox path for one artifact. Colliding names from different attempts include the attempt. */
export function assignGrantContainerPaths(listedPaths: readonly string[]): Map<string, string> {
  const parsed = listedPaths.map((listedPath) => {
    const parts = parseGrantableArtifact(listedPath);
    const base =
      parts === null
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
    if (item.parts === null || item.base === null) continue;
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
