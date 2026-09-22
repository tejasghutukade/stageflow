import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { RunStore } from "./port.js";

const BLOCK_SIZE = 512;
const STATE_DB_NAMES = ["state.db", "state.db-wal", "state.db-shm"] as const;

export type DiskBreakdown = {
  runs_bytes: number;
  worktrees_bytes: number;
  repos_bytes: number;
  state_db_bytes: number;
  a2a_artifacts_bytes: number;
  free_bytes: number;
};

export type FilesystemSize = {
  freeBytes: number;
  totalBytes: number;
};

export type FreeSpaceReader = (rootPath: string) => Promise<FilesystemSize>;

export const DISK_WARN_LOG_PREFIX = "stageflow.disk_warn";

let walkCallCount = 0;
let freeSpaceReaderOverride: FreeSpaceReader | null = null;

export function getDiskUsageWalkCallCount(): number {
  return walkCallCount;
}

export function resetDiskUsageWalkCallCount(): void {
  walkCallCount = 0;
}

export function setFreeSpaceReaderForTests(reader: FreeSpaceReader | null): void {
  freeSpaceReaderOverride = reader;
}

function allocatedBytes(st: { blocks: number }): number {
  return st.blocks * BLOCK_SIZE;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Walk `rootPath` summing `stat().blocks * 512`. Missing path → 0. */
export async function diskUsageOf(rootPath: string): Promise<number> {
  walkCallCount += 1;
  if (!(await pathExists(rootPath))) return 0;

  let total = 0;

  async function walk(current: string): Promise<void> {
    let st;
    try {
      st = await stat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    total += allocatedBytes(st);
    if (!st.isDirectory()) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      await walk(path.join(current, entry.name));
    }
  }

  await walk(rootPath);
  return total;
}

export async function readFilesystemSize(rootPath: string): Promise<FilesystemSize> {
  if (freeSpaceReaderOverride !== null) {
    return freeSpaceReaderOverride(rootPath);
  }
  const fsStats = await statfs(rootPath);
  const blockSize = fsStats.bsize;
  return {
    freeBytes: fsStats.bavail * blockSize,
    totalBytes: fsStats.blocks * blockSize,
  };
}

async function usageOfMissingOk(target: string): Promise<number> {
  try {
    return await diskUsageOf(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function stateDbBytes(durableRoot: string): Promise<number> {
  let total = 0;
  for (const name of STATE_DB_NAMES) {
    const filePath = path.join(durableRoot, name);
    try {
      const st = await stat(filePath);
      if (st.isFile()) {
        walkCallCount += 1;
        total += allocatedBytes(st);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return total;
}

/** Category breakdown for the durable root, reusing `diskUsageOf` for directory trees. */
export async function durableRootDiskBreakdown(
  durableRoot: string,
  options?: { freeSpace?: FreeSpaceReader },
): Promise<DiskBreakdown> {
  const freeSpace = options?.freeSpace ?? readFilesystemSize;
  const [runs_bytes, worktrees_bytes, repos_bytes, state_db_bytes, a2a_artifacts_bytes, size] =
    await Promise.all([
      usageOfMissingOk(path.join(durableRoot, "runs")),
      usageOfMissingOk(path.join(durableRoot, "worktrees")),
      usageOfMissingOk(path.join(durableRoot, "repos")),
      stateDbBytes(durableRoot),
      usageOfMissingOk(path.join(durableRoot, "a2a-artifacts")),
      freeSpace(durableRoot),
    ]);
  return {
    runs_bytes,
    worktrees_bytes,
    repos_bytes,
    state_db_bytes,
    a2a_artifacts_bytes,
    free_bytes: size.freeBytes,
  };
}

/**
 * Parse `STAGEFLOW_DISK_WARN_BYTES` / floor-style env: integer bytes or `N%` of filesystem.
 * Empty / unset / invalid → undefined (no threshold).
 */
export function parseDiskBytesThreshold(
  raw: string | undefined,
  filesystemTotalBytes: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.endsWith("%")) {
    const pct = Number.parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return undefined;
    if (!Number.isFinite(filesystemTotalBytes) || filesystemTotalBytes < 0) {
      return undefined;
    }
    return Math.floor((filesystemTotalBytes * pct) / 100);
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Resolve `STAGEFLOW_MIN_FREE_DISK_BYTES`: bytes or `%` of filesystem.
 * Unset / empty / invalid → `max(2 GiB, 10% of filesystemTotalBytes)`.
 */
export function resolveMinFreeDiskFloor(
  raw: string | undefined,
  filesystemTotalBytes: number,
): number {
  const parsed = parseDiskBytesThreshold(raw, filesystemTotalBytes);
  if (parsed !== undefined) return parsed;
  const total =
    Number.isFinite(filesystemTotalBytes) && filesystemTotalBytes > 0
      ? filesystemTotalBytes
      : 0;
  const tenPercent = Math.floor(total * 0.1);
  return Math.max(DEFAULT_MIN_FREE_DISK_BYTES, tenPercent);
}

/**
 * One named warning when free space is below `STAGEFLOW_DISK_WARN_BYTES`. Never throws.
 * @returns true when a warning line was emitted
 */
export async function warnDurableRootDiskIfNeeded(
  durableRoot: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    freeSpace?: FreeSpaceReader;
    log?: (line: string) => void;
  },
): Promise<boolean> {
  try {
    const env = options?.env ?? process.env;
    const raw = env.STAGEFLOW_DISK_WARN_BYTES;
    if (raw === undefined || raw.trim() === "") return false;

    const freeSpace = options?.freeSpace ?? readFilesystemSize;
    const size = await freeSpace(durableRoot);
    const threshold = parseDiskBytesThreshold(raw, size.totalBytes);
    if (threshold === undefined) return false;
    if (size.freeBytes >= threshold) return false;

    const log = options?.log ?? ((line: string) => console.warn(line));
    log(
      `${DISK_WARN_LOG_PREFIX}: durable root free space ${size.freeBytes} bytes is below threshold ${threshold} bytes (${raw.trim()}); run sf runs gc`,
    );
    return true;
  } catch (err) {
    const log = options?.log ?? ((line: string) => console.warn(line));
    log(
      `${DISK_WARN_LOG_PREFIX}: free-space measurement failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Measure one run workspace and persist `disk_bytes` / `disk_measured_at`. */
export async function refreshRunDiskUsage(
  store: RunStore,
  runId: string,
  options?: { now?: Date },
): Promise<number> {
  const workspaceDir = store.getWorkspaceDir(runId);
  const bytes = await diskUsageOf(workspaceDir);
  const measuredAt = (options?.now ?? new Date()).toISOString();
  await store.setRunDiskUsage(runId, bytes, measuredAt);
  return bytes;
}
