import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const cache = new Map<string, string | null>();

function normalizeRoot(dir: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

export function findProjectRoot(startDir: string): string | null {
  const normalized = path.resolve(startDir);
  if (cache.has(normalized)) {
    return cache.get(normalized) ?? null;
  }

  let result: string | null = null;

  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: normalized,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      result = normalizeRoot(trimmed);
    }
  } catch {
    result = walkForGitRoot(normalized);
  }

  cache.set(normalized, result);
  return result;
}

function walkForGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return normalizeRoot(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function clearFindProjectRootCacheForTests(): void {
  cache.clear();
}
