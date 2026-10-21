import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const cache = new Map<string, string | null>();

function normalizeRoot(dir: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/** Walk up from `startDir` for the nearest `stageflow.yaml`, independent of git. */
export function findManifestRoot(startDir: string): string | null {
  const normalized = path.resolve(startDir);
  if (cache.has(normalized)) {
    return cache.get(normalized) ?? null;
  }

  let dir = normalized;
  let result: string | null = null;
  for (;;) {
    if (existsSync(path.join(dir, "stageflow.yaml"))) {
      result = normalizeRoot(dir);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cache.set(normalized, result);
  return result;
}

export function clearFindManifestRootCacheForTests(): void {
  cache.clear();
}
