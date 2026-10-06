import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { loadPublicationRegistry } from "../a2a/registry.js";
import { a2aConfigPathFor, resolveA2aConfigPath } from "../a2a/configDiscovery.js";

export const A2A_USAGE = `sf a2a validate [--config <path>]
sf a2a list [--config <path>]
sf a2a add-caller <id> [--config <path>] [--token-env <NAME>]

Validate or inspect an A2A publication configuration, or register a new caller.
--config defaults to <project-root>/a2a.yaml when omitted -- the same file
STAGEFLOW_A2A_CONFIG would point at if set. Caller credentials are read from
the environment variables named in the configuration; add-caller only writes
the caller's id and its token_env name to the file, never a secret value.`;

const SCAFFOLD = { version: 1, callers: [] as unknown[], publications: [] as unknown[] };

function deriveTokenEnvName(callerId: string): string {
  const normalized = callerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "CALLER") + "_TOKEN";
}

function parseFlags(args: string[]): { config?: string; tokenEnv?: string; positionals: string[] } {
  let config: string | undefined;
  let tokenEnv: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config") {
      config = args[(i += 1)];
    } else if (args[i] === "--token-env") {
      tokenEnv = args[(i += 1)];
    } else {
      positionals.push(args[i]);
    }
  }
  return { config, tokenEnv, positionals };
}

async function addCaller(
  configPath: string,
  callerId: string,
  tokenEnvOverride: string | undefined,
): Promise<{ tokenEnv: string; token: string; created: boolean }> {
  let raw: string | undefined;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    raw = undefined;
  }
  const config: Record<string, unknown> = raw ? (parse(raw) ?? {}) : { ...SCAFFOLD };
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error(configPath + " does not contain a YAML mapping");
  }
  if (config.version === undefined) config.version = 1;
  if (config.callers === undefined) config.callers = [];
  if (config.publications === undefined) config.publications = [];
  const callers = config.callers;
  if (!Array.isArray(callers)) {
    throw new Error('"callers" in ' + configPath + " is not a list");
  }
  if (callers.some((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === callerId)) {
    throw new Error('Caller "' + callerId + '" already exists in ' + configPath);
  }
  const tokenEnv = tokenEnvOverride ?? deriveTokenEnvName(callerId);
  callers.push({ id: callerId, token_env: tokenEnv });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, stringify(config));
  const token = randomBytes(24).toString("hex");
  return { tokenEnv, token, created: raw === undefined };
}

export async function runA2aCommand(
  args: string[],
  options: {
    cwd: string;
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? options.cwd;

  if (args[0] === "--help" || args[0] === "-h") {
    log(A2A_USAGE);
    return 0;
  }

  const sub = args[0];
  if (sub !== "validate" && sub !== "list" && sub !== "add-caller") {
    error(A2A_USAGE);
    return 1;
  }
  const { config, tokenEnv, positionals } = parseFlags(args.slice(1));

  if (sub === "add-caller") {
    if (positionals.length !== 1 || !positionals[0]) {
      error(A2A_USAGE);
      return 1;
    }
    const configPath = config ? path.resolve(options.cwd, config) : a2aConfigPathFor(projectRoot);
    try {
      const result = await addCaller(configPath, positionals[0], tokenEnv);
      log(JSON.stringify({ ok: true, configPath, callerId: positionals[0], tokenEnv: result.tokenEnv, created: result.created }));
      log('Generated a token for caller "' + positionals[0] + '". Export it before starting the host (or store it in your secrets manager):');
      log("  export " + result.tokenEnv + "=" + result.token);
      if (result.created) {
        log("Created " + configPath + " with no publications yet -- add at least one under `publications:` before this config can be loaded.");
      }
      return 0;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (positionals.length !== 0) {
    error(A2A_USAGE);
    return 1;
  }
  const configPath = config ? path.resolve(options.cwd, config) : resolveA2aConfigPath(projectRoot, env);
  if (!configPath) {
    error("No A2A configuration found. Pass --config <path>, or create " + a2aConfigPathFor(projectRoot) + ".");
    return 1;
  }
  try {
    const registry = await loadPublicationRegistry(configPath, env);
    log(JSON.stringify({ ok: true, configPath: registry.configPath, publicUrl: registry.publicUrl, mode: "discovery", publications: registry.summaries() }));
    if (sub === "list") {
      log("Configuration validated locally. An already-running host must be restarted explicitly to pick up changes.");
    }
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
