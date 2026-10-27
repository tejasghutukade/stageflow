import { lstat } from "node:fs/promises";
import path from "node:path";
import type { TerminalEnvelope } from "../types/envelope.js";
import { isInsideDir } from "../runstore/workspaceLayout.js";
import type { ResolvePriorEnvelopeResult } from "./envelopeRouting.js";

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

export async function grantedPathsFromPriors(
  workspaceDir: string,
  prior: Extract<ResolvePriorEnvelopeResult, { ok: true }>,
): Promise<string[]> {
  const workspaceRoot = path.resolve(workspaceDir);
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const listed of successArtifactsFromPrior(prior)) {
    if (!isGrantableArtifactPath(listed)) continue;
    const abs = path.resolve(workspaceRoot, listed);
    if (!isInsideDir(abs, workspaceRoot) || abs === workspaceRoot) continue;
    if (seen.has(abs)) continue;
    try {
      const stats = await lstat(abs);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    seen.add(abs);
    paths.push(abs);
  }

  return paths;
}
