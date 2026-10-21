import path from "node:path";
import type { RunStore } from "../runstore/port.js";

export function parseEnsureProjectRootsEnv(
  env: NodeJS.ProcessEnv,
): string[] {
  const raw = env.STAGEFLOW_ENSURE_PROJECT_ROOTS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function ensureProjectRootsFromEnv(
  env: NodeJS.ProcessEnv,
  store: RunStore,
): Promise<void> {
  for (const entry of parseEnsureProjectRootsEnv(env)) {
    const abs = path.resolve(entry);
    try {
      await store.ensureProject(abs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`stageflow: could not register project_root ${abs}: ${message}`);
    }
  }
}
