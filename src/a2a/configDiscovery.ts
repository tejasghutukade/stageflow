import { existsSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

export const A2A_CONFIG_FILE_NAME = "a2a.yaml";

/** Where `a2a.yaml` lives when nothing else says otherwise: next to `stageflow.yaml`, at the project root. */
export function a2aConfigPathFor(projectRoot: string): string {
  return path.join(projectRoot, A2A_CONFIG_FILE_NAME);
}

/** The host-level file under the Host's data directory, the same way `connections.yaml` is found. */
export function hostA2aConfigFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.STAGEFLOW_HOME?.trim() || (env === process.env ? globalStageflowHome() : undefined);
  return home ? path.join(path.resolve(home), A2A_CONFIG_FILE_NAME) : undefined;
}

/**
 * `STAGEFLOW_A2A_CONFIG` always wins when set (an explicit override, e.g. a config file living
 * outside the project). Otherwise, `<projectRoot>/a2a.yaml` is used if it exists -- the same
 * auto-discovery convention `stageflow.yaml` already follows for the pipeline catalog -- and then
 * `$STAGEFLOW_HOME/a2a.yaml` if it exists. Returns undefined (A2A disabled) when none is present.
 */
export function resolveA2aConfigPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.STAGEFLOW_A2A_CONFIG) return env.STAGEFLOW_A2A_CONFIG;
  const candidate = a2aConfigPathFor(projectRoot);
  if (existsSync(candidate)) return candidate;
  const host = hostA2aConfigFile(env);
  return host && existsSync(host) ? host : undefined;
}

/** The file the management API writes: the resolved file if there is one, else the host-level file. */
export function a2aWriteTargetPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveA2aConfigPath(projectRoot, env) ?? hostA2aConfigFile(env) ?? a2aConfigPathFor(projectRoot);
}
