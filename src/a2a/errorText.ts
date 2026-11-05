import { realpathSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

function variants(prefix: string): string[] {
  const trimmed = prefix.replace(/[\\/]+$/, "");
  try {
    return [trimmed, realpathSync(trimmed)];
  } catch {
    return [trimmed];
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Error text the A2A API or status may show: paths under a known folder become relative to it, and any
 * other absolute path is cut to its last segment, so no server filesystem layout leaves the Host.
 * A known folder only matches where a path starts and at a folder boundary (`/data` never matches `/srv/data` or `/data2`).
 */
export function scrubA2aPaths(message: string, prefixes: readonly (string | undefined)[]): string {
  const known = [...new Set(prefixes.flatMap((prefix) => (prefix ? variants(prefix) : [])))]
    .filter((prefix) => prefix.length > 1)
    .sort((a, b) => b.length - a.length);
  let out = message;
  for (const prefix of known) {
    const at = new RegExp(`(?<![^\\s'"\`(=])${escapeRegExp(prefix)}(?:([\\\\/])|(?=[\\s'"\`),;]|$))`, "g");
    out = out.replace(at, (_match, separator: string | undefined) => (separator ? "" : "."));
  }
  return out.replace(/(?<![\w:/.\\-])(?:[A-Za-z]:)?(?:[\\/][^\s'"`\\/]+)+[\\/]([^\s'"`\\/]+)/g, "$1");
}

/** `file` relative to `home` when it is inside it, else its file name. Never absolute. */
export function pathForDisplay(file: string, home: string): string {
  const windows = /^[A-Za-z]:\\/.test(file);
  const p = windows ? path.win32 : path.posix;
  for (const base of windows ? [home] : variants(home)) {
    const relative = p.relative(base, file);
    if (relative !== "" && !relative.startsWith("..") && !p.isAbsolute(relative)) return relative;
  }
  return p.basename(file);
}

export type A2aConfigSource = "home" | "project" | "override";

function sameFile(a: string, b: string): boolean {
  const resolve = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return resolve(a) === resolve(b);
}

/** Which discovery rule found the file: `STAGEFLOW_A2A_CONFIG`, the Stageflow home, or the project root. */
export function a2aConfigSource(file: string, home: string, env: NodeJS.ProcessEnv = process.env): A2aConfigSource {
  if (env.STAGEFLOW_A2A_CONFIG && sameFile(env.STAGEFLOW_A2A_CONFIG, file)) return "override";
  const insideHome = variants(home).some((base) => {
    const relative = path.relative(base, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  return insideHome ? "home" : "project";
}

/**
 * A2A status as the API returns it: `configPath` relative to the Stageflow home (or its file name), never absolute,
 * and `configSource`, so a project `a2a.yaml` and the home one are told apart.
 */
export function a2aStatusView<T extends { configPath?: string }>(
  status: T,
  home: string = globalStageflowHome(),
  env: NodeJS.ProcessEnv = process.env,
): T & { configSource?: A2aConfigSource } {
  if (!status.configPath) return status;
  return { ...status, configPath: pathForDisplay(status.configPath, home), configSource: a2aConfigSource(status.configPath, home, env) };
}
