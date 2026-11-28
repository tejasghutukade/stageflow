import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { A2aStore } from "../a2a/store.js";
import { bareCachePath } from "../git/cache.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { logArtifactIndexFailure } from "../runstore/artifactRetention.js";
import {
  bareCacheTtlFromEnv,
  isTerminalRunStatus,
  retentionDecision,
  retentionWindowsFromEnv,
  slimArtifactMaxBytesFromEnv,
  type RetentionWindows,
} from "../runstore/retention.js";
import type { RunMeta, RunStore, RunSummary } from "../runstore/port.js";
import {
  reclaimWorkspaceBinding,
  worktreePathForRun,
} from "./repositoryMaterialize.js";
import { deleteRunEverywhere } from "./runDeletion.js";
import { expireDueSessionArtifacts } from "../artifacts/sessionScope.js";
import { pruneFunctionInvocations } from "../functions/history.js";
import { sqliteConnectionFromStore } from "../runstore/createStore.js";

// Slot 6: $STAGEFLOW_HOME/cache is shared dependency state — never walk or
// delete it from slim/purge; health reports it as disk.cache_bytes separately.

export type RetentionSweepReport = {
  slimmed: string[];
  purged: string[];
  bareCachesEvicted: string[];
};

export type RunRetentionSweepOptions = {
  now?: Date;
  /** When false (default), compute candidates but skip mutating calls. */
  execute?: boolean;
  windows?: RetentionWindows;
  env?: NodeJS.ProcessEnv;
  artifactMaxBytes?: number;
  bareCacheTtlMs?: number;
  /** Available indexed rows inspected for a missing file. Zero skips the repair pass. */
  artifactRepairBatch?: number;
  /**
   * Replaces the workspace file slim. Return false when the slim did not finish
   * and oversized files may still be on disk.
   */
  slimWorkspace?: (workspaceDir: string, maxBytes: number) => Promise<boolean | void>;
};

const SLIM_ATTEMPT_FILES = ["pi-session.jsonl", "stream.log"] as const;
const SLIM_ATTEMPT_DIRS = [".pi-agent"] as const;

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function rmForce(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `runRetentionSweep: rm failed for ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function removeOversizedArtifacts(
  artifactsDir: string,
  maxBytes: number,
): Promise<void> {
  if (!(await pathExists(artifactsDir))) return;

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = await stat(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (st.size > maxBytes) {
        await rmForce(full);
      }
    }
  }

  await walk(artifactsDir);
}

async function slimAttemptDir(
  attemptDir: string,
  maxBytes: number,
): Promise<void> {
  for (const name of SLIM_ATTEMPT_DIRS) {
    await rmForce(path.join(attemptDir, name));
  }
  for (const name of SLIM_ATTEMPT_FILES) {
    await rmForce(path.join(attemptDir, name));
  }
  await removeOversizedArtifacts(path.join(attemptDir, "artifacts"), maxBytes);
}

/**
 * Walk attempt + legacy artifact trees and remove SLIM-eligible paths.
 * Never removes envelope.json, log.jsonl, or under-threshold artifacts.
 */
export async function slimRunWorkspaceArtifacts(
  workspaceDir: string,
  maxBytes: number,
): Promise<boolean> {
  const stagesRoot = path.join(workspaceDir, "stages");
  if (!(await pathExists(stagesRoot))) return true;

  let stageEntries;
  try {
    stageEntries = await readdir(stagesRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }

  for (const stageEntry of stageEntries) {
    if (!stageEntry.isDirectory()) continue;
    const stageDir = path.join(stagesRoot, stageEntry.name);
    const attemptsRoot = path.join(stageDir, "attempts");
    if (await pathExists(attemptsRoot)) {
      let attemptEntries;
      try {
        attemptEntries = await readdir(attemptsRoot, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      for (const attemptEntry of attemptEntries) {
        if (!attemptEntry.isDirectory()) continue;
        await slimAttemptDir(
          path.join(attemptsRoot, attemptEntry.name),
          maxBytes,
        );
      }
    }
    await removeOversizedArtifacts(path.join(stageDir, "artifacts"), maxBytes);
  }
  return true;
}

async function slimOneRun(
  store: RunStore,
  meta: RunMeta,
  now: Date,
  artifactMaxBytes: number,
  slimWorkspace?: (workspaceDir: string, maxBytes: number) => Promise<boolean | void>,
): Promise<boolean> {
  try {
    await reclaimWorkspaceBinding(meta, { keepRunBranch: true });
  } catch (err) {
    console.error(
      `runRetentionSweep: worktree reclaim failed for ${meta.run_id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  const workspaceDir = store.getWorkspaceDir(meta.run_id);
  let marked: string[] = [];
  try {
    marked = await store.markSlimmedIndexedArtifacts(
      meta.run_id,
      artifactMaxBytes,
      now.toISOString(),
    );
  } catch (err) {
    logArtifactIndexFailure(`runRetentionSweep slim ${meta.run_id}`, err);
  }
  let slimOk = true;
  try {
    const result = slimWorkspace
      ? await slimWorkspace(workspaceDir, artifactMaxBytes)
      : await slimRunWorkspaceArtifacts(workspaceDir, artifactMaxBytes);
    if (result === false) slimOk = false;
  } catch (err) {
    console.error(
      `runRetentionSweep: artifact slim failed for ${meta.run_id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    slimOk = false;
  }
  if (!slimOk) {
    try {
      await store.restorePresentSlimmedIndexedArtifacts(meta.run_id, marked);
    } catch (err) {
      logArtifactIndexFailure(`runRetentionSweep slim restore ${meta.run_id}`, err);
    }
    return false;
  }

  await store.setSlimmedAt(meta.run_id, now.toISOString());
  return true;
}

async function listBareCachePaths(reposRoot: string): Promise<string[]> {
  if (!(await pathExists(reposRoot))) return [];
  const out: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith(".git")) {
        out.push(full);
      } else {
        await walk(full);
      }
    }
  }

  await walk(reposRoot);
  return out;
}

function repositoryForCachePath(cachePath: string): string | undefined {
  const reposRoot = path.join(globalStageflowHome(), "repos");
  const rel = path.relative(reposRoot, cachePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.length < 3) return undefined;
  const owner = parts[parts.length - 2];
  const repoGit = parts[parts.length - 1];
  if (!repoGit.endsWith(".git")) return undefined;
  return `${owner}/${repoGit.slice(0, -".git".length)}`;
}

function repositoryOf(run: RunSummary | RunMeta): string | undefined {
  if ("binding" in run && run.binding?.repository) {
    return run.binding.repository;
  }
  if ("repository" in run && run.repository) {
    return run.repository;
  }
  return undefined;
}

function runsForRepository(
  runs: Array<RunSummary | RunMeta>,
  repository: string,
): Array<RunSummary | RunMeta> {
  return runs.filter((r) => repositoryOf(r) === repository);
}

async function hasLiveWorktree(
  runs: Array<RunSummary | RunMeta>,
): Promise<boolean> {
  for (const run of runs) {
    const checkout =
      "checkout_root" in run && typeof run.checkout_root === "string"
        ? run.checkout_root
        : undefined;
    const candidates = [
      ...(checkout ? [checkout] : []),
      worktreePathForRun(run.run_id),
    ];
    for (const candidate of candidates) {
      if (candidate !== "" && (await pathExists(candidate))) return true;
    }
  }
  return false;
}

function allReferencingRunsPastBareTtl(
  runs: Array<RunSummary | RunMeta>,
  now: Date,
  ttlMs: number,
): boolean {
  if (runs.length === 0) return true;
  for (const run of runs) {
    if (!isTerminalRunStatus(run.status)) return false;
    if (run.finished_at === undefined || run.finished_at === "") return false;
    const finishedMs = Date.parse(run.finished_at);
    if (!Number.isFinite(finishedMs)) return false;
    if (now.getTime() - finishedMs < ttlMs) return false;
  }
  return true;
}

async function evictBareCaches(options: {
  runs: Array<RunSummary | RunMeta>;
  now: Date;
  ttlMs: number;
  execute: boolean;
}): Promise<string[]> {
  const reposRoot = path.join(globalStageflowHome(), "repos");
  const caches = await listBareCachePaths(reposRoot);
  const evicted: string[] = [];

  for (const cachePath of caches) {
    const repository = repositoryForCachePath(cachePath);
    if (repository === undefined) continue;
    // Prefer store-based live-worktree check (cheaper than `git worktree list`).
    const referencing = runsForRepository(options.runs, repository);
    if (await hasLiveWorktree(referencing)) continue;
    if (!allReferencingRunsPastBareTtl(referencing, options.now, options.ttlMs)) {
      continue;
    }
    evicted.push(cachePath);
    if (options.execute) {
      await rmForce(cachePath);
    }
  }

  return evicted;
}

/**
 * Two-stage retention: SLIM then PURGE, then bare-cache eviction.
 * Dry-run (`execute: false`) computes the same candidates and skips mutations.
 */
export async function runRetentionSweep(
  store: RunStore,
  a2aStore: A2aStore | undefined,
  options: RunRetentionSweepOptions = {},
): Promise<RetentionSweepReport> {
  const now = options.now ?? new Date();
  const execute = options.execute === true;
  const env = options.env ?? process.env;
  const windows = options.windows ?? retentionWindowsFromEnv(env);
  const artifactMaxBytes =
    options.artifactMaxBytes ?? slimArtifactMaxBytesFromEnv(env);
  const bareCacheTtlMs = options.bareCacheTtlMs ?? bareCacheTtlFromEnv(env);

  const runs = await store.listRuns({ origin: "any" });
  const slimmed: string[] = [];
  const purged: string[] = [];

  const metas = new Map<string, RunMeta>();
  async function metaFor(runId: string): Promise<RunMeta> {
    let meta = metas.get(runId);
    if (meta === undefined) {
      meta = await store.readRunMeta(runId);
      metas.set(runId, meta);
    }
    return meta;
  }

  // Decide from durable meta (status/finished_at/slimmed_at), not listRuns'
  // derived status — stage rows can make a terminal run look "running".
  const decisions: Array<{ runId: string; decision: "slim" | "purge" }> = [];
  for (const summary of runs) {
    const meta = await metaFor(summary.run_id);
    const decision = retentionDecision(meta, now, windows);
    if (decision === "slim" || decision === "purge") {
      decisions.push({ runId: summary.run_id, decision });
    }
  }

  const purgeCandidates = decisions.filter((d) => d.decision === "purge");
  if (execute && a2aStore === undefined && purgeCandidates.length > 0) {
    throw new Error(
      "runRetentionSweep: a2aStore is required when execute is true and PURGE candidates exist",
    );
  }

  for (const { runId, decision } of decisions) {
    if (decision !== "slim") continue;
    const meta = await metaFor(runId);
    if (execute) {
      const ok = await slimOneRun(store, meta, now, artifactMaxBytes, options.slimWorkspace);
      if (!ok) continue;
      slimmed.push(runId);
      metas.set(runId, {
        ...meta,
        slimmed_at: now.toISOString(),
      });
    } else {
      slimmed.push(runId);
    }
  }

  for (const { runId, decision } of decisions) {
    if (decision !== "purge") continue;
    purged.push(runId);
    if (execute) {
      try {
        await deleteRunEverywhere(store, a2aStore!, runId, "run_purged");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.startsWith("Run not found:")) throw err;
        console.error(`runRetentionSweep: purge skipped missing run ${runId}: ${message}`);
      }
    }
  }

  if (execute) {
    try {
      await store.repairMissingIndexedArtifacts(
        now.toISOString(),
        options.artifactRepairBatch,
      );
    } catch (err) {
      logArtifactIndexFailure("runRetentionSweep repair", err);
    }
  }

  // Re-list for bare-cache decisions after PURGE removed rows when execute.
  const runsForBare = execute ? await store.listRuns({ origin: "any" }) : runs;
  const bareCachesEvicted = await evictBareCaches({
    runs: runsForBare,
    now,
    ttlMs: bareCacheTtlMs,
    execute,
  });

  if (execute) {
    try {
      const db = sqliteConnectionFromStore(store);
      if (db) {
        pruneFunctionInvocations(db, now, env);
        expireDueSessionArtifacts(db, now.toISOString());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`runRetentionSweep: function history prune failed: ${message}`);
    }
  }

  return { slimmed, purged, bareCachesEvicted };
}

/** Test helper: expose bare-cache path resolution used by the eviction pass. */
export function bareCachePathForRepository(repository: string): string {
  return bareCachePath(repository);
}
