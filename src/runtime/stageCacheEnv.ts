import { mkdirSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

export function stageflowCacheRoot(
  home: string = globalStageflowHome(),
): string {
  return path.join(home, "cache");
}

/** Compute cache env vars without creating directories (lazy create is separate). */
export function computeCacheEnvVars(
  home: string = globalStageflowHome(),
): Record<string, string> {
  const cache = stageflowCacheRoot(home);
  return {
    STAGEFLOW_CACHE: cache,
    npm_config_cache: path.join(cache, "npm"),
    PNPM_STORE_DIR: path.join(cache, "pnpm"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    GOMODCACHE: path.join(cache, "go", "mod"),
    CARGO_HOME: path.join(cache, "cargo"),
  };
}

let cacheEnsured = false;

/** Lazily create shared cache directories at first stage launch. */
export function ensureStageCacheDirs(
  home: string = globalStageflowHome(),
): Record<string, string> {
  const vars = computeCacheEnvVars(home);
  if (!cacheEnsured) {
    for (const value of Object.values(vars)) {
      mkdirSync(value, { recursive: true });
    }
    cacheEnsured = true;
  }
  return vars;
}

export function resetStageCacheDirsForTests(): void {
  cacheEnsured = false;
}
