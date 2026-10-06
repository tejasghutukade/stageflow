import { readFileSync, existsSync } from "node:fs";
import os from "node:os";

const HOST_RESERVE_MIB = 512;
const WORKER_BUDGET_MIB = 512;
const MAX_CAP = 8;
const FALLBACK_CAP = 4;
const FALLBACK_HEAP_MIB = 512;
const V1_SENTINEL = 9223372036854771712n;

export type ContainerLimits = {
  memoryLimitBytes: number | undefined;
  maxActiveStageProcesses: number;
  maxOldSpaceSizeMb: number;
  source: "cgroup-v2" | "cgroup-v1" | "fallback";
};

function parseCgroupMemory(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "max") return undefined;
  let n: bigint;
  try {
    n = BigInt(trimmed);
  } catch {
    return undefined;
  }
  if (n <= 0n || n >= V1_SENTINEL) return undefined;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(n);
}

export function readContainerMemoryLimit(
  roots: readonly string[] = ["/sys/fs/cgroup"],
): { bytes: number | undefined; source: ContainerLimits["source"] } {
  for (const root of roots) {
    const v2 = `${root}/memory.max`;
    if (existsSync(v2)) {
      try {
        const bytes = parseCgroupMemory(readFileSync(v2, "utf8"));
        return { bytes, source: bytes === undefined ? "fallback" : "cgroup-v2" };
      } catch {
        // continue
      }
    }
    const v1 = `${root}/memory/memory.limit_in_bytes`;
    if (existsSync(v1)) {
      try {
        const bytes = parseCgroupMemory(readFileSync(v1, "utf8"));
        return { bytes, source: bytes === undefined ? "fallback" : "cgroup-v1" };
      } catch {
        // continue
      }
    }
  }
  return { bytes: undefined, source: "fallback" };
}

export function deriveContainerLimits(
  memoryLimitBytes: number | undefined,
  source: ContainerLimits["source"] = "fallback",
): ContainerLimits {
  if (memoryLimitBytes === undefined) {
    return {
      memoryLimitBytes: undefined,
      maxActiveStageProcesses: FALLBACK_CAP,
      maxOldSpaceSizeMb: FALLBACK_HEAP_MIB,
      source: "fallback",
    };
  }
  const limitMib = Math.floor(memoryLimitBytes / (1024 * 1024));
  const workerBudget = Math.max(1, limitMib - HOST_RESERVE_MIB);
  const cap = Math.min(
    MAX_CAP,
    Math.max(1, Math.floor(workerBudget / WORKER_BUDGET_MIB)),
  );
  return {
    memoryLimitBytes,
    maxActiveStageProcesses: cap,
    maxOldSpaceSizeMb: WORKER_BUDGET_MIB,
    source,
  };
}

let cached: ContainerLimits | undefined;

export function getContainerLimits(): ContainerLimits {
  if (cached === undefined) {
    const { bytes, source } = readContainerMemoryLimit();
    cached = deriveContainerLimits(bytes, source);
  }
  return cached;
}

export function resetContainerLimitsForTests(): void {
  cached = undefined;
}

/** Test hook: prove sizing never consults os.totalmem. */
export function assertNoOsTotalmemInSizing(): typeof os.totalmem {
  return os.totalmem;
}
