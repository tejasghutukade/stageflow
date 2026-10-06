import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import semver from "semver";
import type { ToolRequirement } from "../config/toolRequires.js";
import { resolveCommandOnPath } from "./mcpCommands.js";
import { buildStageEnvironment } from "../runtime/stageEnvironment.js";

export const DEFAULT_TOOLCHAIN_MANIFEST_PATH =
  "/etc/stageflow/toolchain.json";
export const TOOLCHAIN_MANIFEST_ENV = "STAGEFLOW_TOOLCHAIN_MANIFEST";

export type ToolchainManifestEntry = {
  path: string;
  version: string;
};

export type ToolchainManifest = {
  tools: Record<string, ToolchainManifestEntry>;
};

export type ToolchainCheckStatus =
  | "ok"
  | "missing_tool"
  | "tool_version_mismatch"
  | "unknown_version";

export type ToolchainCheck = {
  tool: string;
  required?: string;
  found?: string;
  path?: string;
  status: ToolchainCheckStatus;
  origin: "manifest" | "path" | "none";
};

export type ToolchainCheckResult = {
  ok: boolean;
  checks: ToolchainCheck[];
};

export type ToolchainHealthMap = Record<string, string>;

export function resolveToolchainManifestPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[TOOLCHAIN_MANIFEST_ENV]?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_TOOLCHAIN_MANIFEST_PATH;
}

export function loadToolchainManifest(
  manifestPath: string = resolveToolchainManifestPath(),
): ToolchainManifest | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      typeof (raw as { tools?: unknown }).tools !== "object" ||
      (raw as { tools: unknown }).tools === null ||
      Array.isArray((raw as { tools: unknown }).tools)
    ) {
      return undefined;
    }
    const tools: Record<string, ToolchainManifestEntry> = {};
    for (const [name, entry] of Object.entries(
      (raw as { tools: Record<string, unknown> }).tools,
    )) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as { path?: unknown }).path !== "string" ||
        typeof (entry as { version?: unknown }).version !== "string"
      ) {
        continue;
      }
      tools[name] = {
        path: (entry as { path: string }).path,
        version: (entry as { version: string }).version,
      };
    }
    return { tools };
  } catch {
    return undefined;
  }
}

function parseVersionFromOutput(output: string): string | undefined {
  const coerced = semver.coerce(output, { loose: true });
  return coerced?.version;
}

function probeToolVersion(
  commandPath: string,
  env: NodeJS.ProcessEnv,
): { version?: string; parsable: boolean } {
  const result = spawnSync(commandPath, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 5_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (!output) return { parsable: false };
  const version = parseVersionFromOutput(output);
  if (version === undefined) return { parsable: false };
  return { version, parsable: true };
}

function resolveToolFromPath(
  tool: string,
  env: NodeJS.ProcessEnv,
): { path: string; version?: string; parsable: boolean } | undefined {
  const resolved = resolveCommandOnPath(tool, env);
  if (resolved === undefined) return undefined;
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    return undefined;
  }
  const probed = probeToolVersion(resolved, env);
  return { path: resolved, version: probed.version, parsable: probed.parsable };
}

/** Build the curated stage env PATH (Slot 6 allowlist) for preflight checks. */
export function curatedStageEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const built = buildStageEnvironment({ hostEnv });
  return { ...built.env };
}

export function toolchainHealthMap(options?: {
  manifest?: ToolchainManifest;
  env?: NodeJS.ProcessEnv;
}): ToolchainHealthMap {
  const env = options?.env ?? process.env;
  const manifest =
    options?.manifest ?? loadToolchainManifest(resolveToolchainManifestPath(env));
  const map: ToolchainHealthMap = {};
  if (manifest) {
    for (const [name, entry] of Object.entries(manifest.tools)) {
      map[name] = entry.version;
    }
  }
  for (const name of ["node", "git", "bash"]) {
    if (map[name] !== undefined) continue;
    if (name === "node") {
      map.node = process.versions.node;
      continue;
    }
    const live = resolveToolFromPath(name, curatedStageEnv(env));
    if (live?.version) map[name] = live.version;
  }
  return map;
}

export type CheckToolchainOptions = {
  /** Injected manifest (tests); when omitted, load from disk. */
  manifest?: ToolchainManifest | null;
  env?: NodeJS.ProcessEnv;
  /** When true, unknown_version is a failing status. */
  strict?: boolean;
  /** Fail start/doctor when mismatch/missing; unknown_version fails only if strict. */
  failOnUnknownVersion?: boolean;
};

export function checkToolchainRequirements(
  requirements: readonly ToolRequirement[],
  options: CheckToolchainOptions = {},
): ToolchainCheckResult {
  const hostEnv = options.env ?? process.env;
  const stageEnv = curatedStageEnv(hostEnv);
  const failOnUnknown =
    options.failOnUnknownVersion === true || options.strict === true;

  let manifest: ToolchainManifest | undefined;
  if (options.manifest === null) {
    manifest = undefined;
  } else if (options.manifest !== undefined) {
    manifest = options.manifest;
  } else {
    manifest = loadToolchainManifest(resolveToolchainManifestPath(hostEnv));
  }

  const checks: ToolchainCheck[] = [];
  for (const req of requirements) {
    const fromManifest = manifest?.tools[req.tool];
    let foundPath: string | undefined;
    let foundVersion: string | undefined;
    let origin: ToolchainCheck["origin"] = "none";
    let parsable = false;

    if (fromManifest) {
      foundPath = fromManifest.path;
      foundVersion = fromManifest.version;
      origin = "manifest";
      parsable = Boolean(semver.valid(fromManifest.version));
      if (!parsable) {
        const coerced = semver.coerce(fromManifest.version, { loose: true });
        if (coerced) {
          foundVersion = coerced.version;
          parsable = true;
        }
      }
    } else {
      const live = resolveToolFromPath(req.tool, stageEnv);
      if (live) {
        foundPath = live.path;
        foundVersion = live.version;
        origin = "path";
        parsable = live.parsable;
      }
    }

    if (foundPath === undefined) {
      checks.push({
        tool: req.tool,
        required: req.version,
        status: "missing_tool",
        origin: "none",
      });
      continue;
    }

    if (req.version === undefined) {
      checks.push({
        tool: req.tool,
        found: foundVersion,
        path: foundPath,
        status: "ok",
        origin,
      });
      continue;
    }

    if (!parsable || foundVersion === undefined) {
      checks.push({
        tool: req.tool,
        required: req.version,
        found: foundVersion,
        path: foundPath,
        status: "unknown_version",
        origin,
      });
      continue;
    }

    if (!semver.satisfies(foundVersion, req.version)) {
      checks.push({
        tool: req.tool,
        required: req.version,
        found: foundVersion,
        path: foundPath,
        status: "tool_version_mismatch",
        origin,
      });
      continue;
    }

    checks.push({
      tool: req.tool,
      required: req.version,
      found: foundVersion,
      path: foundPath,
      status: "ok",
      origin,
    });
  }

  const ok = !checks.some((c) => {
    if (c.status === "missing_tool" || c.status === "tool_version_mismatch") {
      return true;
    }
    if (c.status === "unknown_version") return failOnUnknown;
    return false;
  });

  return { ok, checks };
}

export function firstFailingToolchainCode(
  result: ToolchainCheckResult,
  options: { strict?: boolean } = {},
): "missing_tool" | "tool_version_mismatch" | "unknown_version" | undefined {
  for (const check of result.checks) {
    if (check.status === "missing_tool") return "missing_tool";
    if (check.status === "tool_version_mismatch") return "tool_version_mismatch";
    if (check.status === "unknown_version" && options.strict) {
      return "unknown_version";
    }
  }
  return undefined;
}
