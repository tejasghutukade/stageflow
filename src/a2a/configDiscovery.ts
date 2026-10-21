import { existsSync } from "node:fs";
import path from "node:path";

/** Where `a2a.yaml` lives when nothing else says otherwise: next to `stageflow.yaml`, at the project root. */
export function a2aConfigPathFor(projectRoot: string): string {
  return path.join(projectRoot, "a2a.yaml");
}

/**
 * `STAGEFLOW_A2A_CONFIG` always wins when set (an explicit override, e.g. a config file living
 * outside the project). Otherwise, `<projectRoot>/a2a.yaml` is used if it exists -- the same
 * auto-discovery convention `stageflow.yaml` already follows for the pipeline catalog. Returns
 * undefined (A2A disabled) when neither is present.
 */
export function resolveA2aConfigPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.STAGEFLOW_A2A_CONFIG) return env.STAGEFLOW_A2A_CONFIG;
  const candidate = a2aConfigPathFor(projectRoot);
  return existsSync(candidate) ? candidate : undefined;
}
