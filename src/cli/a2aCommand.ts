import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { loadPublicationRegistry } from "../a2a/registry.js";
import { a2aConfigPathFor, resolveA2aConfigPath } from "../a2a/configDiscovery.js";
import { ensureGlobalService, hostBaseUrl, type EnsureGlobalServiceResult } from "../server/ensureGlobalService.js";
import { httpRequestJson } from "./hostClient.js";

export const A2A_USAGE = `sf a2a status [--json]
sf a2a enable [--public-url <url>] [--json]
sf a2a reload [--json]
sf a2a caller list [--json]
sf a2a caller create <id> [--allow-run-stage] [--json]
sf a2a caller update <id> (--allow-run-stage | --no-allow-run-stage) [--json]
sf a2a caller revoke <id> [--json]
sf a2a publication list [--json]
sf a2a publication create <file> [--json]
sf a2a publication edit <id> <file> [--json]
sf a2a publication remove <id> [--json]
sf a2a validate [--config <path>]
sf a2a list [--config <path>]
sf a2a add-caller <id> [--config <path>] [--token-env <NAME>]

status, enable, reload, caller and publication talk to the running Host (started
for you when none is running) and take effect without a restart. The token of a
new caller is printed once and never stored; the Host keeps only its SHA-256
digest. allow_run_stage stays off until an operator passes --allow-run-stage
on create or update. caller list prints the flag. An opted-in caller has shell
on the Host and can read any run's envelopes. No agent tool sets the flag.
<file> is a YAML or JSON publication body (project_root is a catalog
project, pipeline and input_schema are paths inside it; without input_schema the
entry stage's io.input.schema is used).

validate and list check a configuration file locally. add-caller edits a file
and uses a token read from an environment variable (token_env); the Host reads
that variable only when it starts. --config defaults to the A2A configuration
found for the project (a2a.yaml next to stageflow.yaml, else $STAGEFLOW_HOME/a2a.yaml).`;

const SCAFFOLD = { version: 1, callers: [] as unknown[], publications: [] as unknown[] };

function deriveTokenEnvName(callerId: string): string {
  const normalized = callerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "CALLER") + "_TOKEN";
}

function parseFlags(args: string[]): { config?: string; tokenEnv?: string; publicUrl?: string; json: boolean; allowRunStage?: boolean; positionals: string[] } {
  let config: string | undefined;
  let tokenEnv: string | undefined;
  let publicUrl: string | undefined;
  let json = false;
  let allowRunStage: boolean | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config") {
      config = args[(i += 1)];
    } else if (args[i] === "--token-env") {
      tokenEnv = args[(i += 1)];
    } else if (args[i] === "--public-url") {
      publicUrl = args[(i += 1)];
    } else if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--allow-run-stage") {
      allowRunStage = true;
    } else if (args[i] === "--no-allow-run-stage") {
      allowRunStage = false;
    } else {
      positionals.push(args[i]);
    }
  }
  return { config, tokenEnv, publicUrl, json, allowRunStage, positionals };
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

type ApiResult = { status: number; body: unknown };

function apiError(result: ApiResult): string {
  const body = result.body as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : `request to the Stageflow Host failed (status ${result.status})`;
}

async function readBodyFile(file: string, cwd: string): Promise<unknown> {
  const parsed: unknown = parse(await readFile(path.resolve(cwd, file), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(file + " does not contain an object");
  return parsed;
}

function describeStatus(status: Record<string, unknown>): string[] {
  const lines = ["A2A: " + String(status.state)];
  if (status.agentCardUrl) lines.push("Agent card: " + String(status.agentCardUrl));
  if (status.configPath) lines.push("Config: " + String(status.configPath));
  if (typeof status.callers === "number") lines.push("Callers: " + status.callers + ", publications: " + String(status.publications));
  const error = status.error as { message?: string } | undefined;
  if (error?.message) lines.push("Error: " + error.message);
  const last = status.lastReload as { ok: boolean; at: string; error?: { message?: string } } | undefined;
  if (last) lines.push("Last reload: " + (last.ok ? "ok" : "failed (" + (last.error?.message ?? "unknown") + ")") + " at " + last.at);
  return lines;
}

const MANAGE_COMMANDS = new Set(["status", "enable", "reload", "caller", "publication"]);

async function runManageCommand(
  sub: string,
  args: string[],
  flags: ReturnType<typeof parseFlags>,
  options: { cwd: string; log: (line: string) => void; error: (line: string) => void; hostBaseUrl?: string; ensureService?: () => Promise<EnsureGlobalServiceResult> },
): Promise<number> {
  const { log, error } = options;
  const [action, ...rest] = flags.positionals;
  let request: { method: string; path: string; body?: unknown } | undefined;
  let render: (body: any) => void = () => undefined;
  const bad = (): number => { error(A2A_USAGE); return 1; };
  if (flags.allowRunStage !== undefined && sub !== "caller") return bad();
  const idPath = (prefix: string, id: string | undefined): string | undefined => (id ? prefix + encodeURIComponent(id) : undefined);

  if (sub === "status" && flags.positionals.length === 0) {
    request = { method: "GET", path: "/api/a2a/status" };
    render = (body) => describeStatus(body).forEach(log);
  } else if (sub === "enable" && flags.positionals.length === 0) {
    request = { method: "POST", path: "/api/a2a/enable", body: flags.publicUrl !== undefined ? { public_url: flags.publicUrl } : {} };
    render = (body) => describeStatus(body).forEach(log);
  } else if (sub === "reload" && flags.positionals.length === 0) {
    request = { method: "POST", path: "/api/a2a/reload" };
    render = (body) => describeStatus(body).forEach(log);
  } else if (sub === "caller") {
    if (action === "list" && rest.length === 0 && flags.allowRunStage === undefined) {
      request = { method: "GET", path: "/api/a2a/callers" };
      render = (body) => body.callers.forEach((c: { id: string; token_source: string; allow_run_stage?: boolean }) =>
        log(c.id + "\t" + c.token_source + "\tallow_run_stage=" + String(c.allow_run_stage === true)));
    } else if (action === "create" && rest.length === 1) {
      const body: { id: string; allow_run_stage?: boolean } = { id: rest[0] };
      if (flags.allowRunStage !== undefined) body.allow_run_stage = flags.allowRunStage;
      request = { method: "POST", path: "/api/a2a/callers", body };
      render = (created) => {
        log('Created caller "' + created.id + '". This token is shown once and is not stored; the Host keeps only its digest:');
        log("  " + created.token);
        log("The caller sends it as: Authorization: Bearer <token>");
        log("allow_run_stage: " + String(created.allow_run_stage === true));
      };
    } else if (action === "update" && rest.length === 1 && flags.allowRunStage !== undefined) {
      request = { method: "PATCH", path: idPath("/api/a2a/callers/", rest[0])!, body: { allow_run_stage: flags.allowRunStage } };
      render = (updated) => log(updated.id + "\tallow_run_stage=" + String(updated.allow_run_stage === true));
    } else if (action === "revoke" && rest.length === 1 && flags.allowRunStage === undefined) {
      request = { method: "DELETE", path: idPath("/api/a2a/callers/", rest[0])! };
      render = (body) => log('Revoked caller "' + rest[0] + '"' + (body.removed_from.length ? "; removed from " + body.removed_from.join(", ") : ""));
    }
  } else if (sub === "publication") {
    if (action === "list" && rest.length === 0) {
      request = { method: "GET", path: "/api/a2a/publications" };
      render = (body) => body.publications.forEach((p: { id: string; allowed_callers: string[] }) => log(p.id + "\t" + p.allowed_callers.join(",")));
    } else if (action === "create" && rest.length === 1) {
      request = { method: "POST", path: "/api/a2a/publications", body: await readBodyFile(rest[0], options.cwd) };
      render = (body) => log('Published "' + body.id + '"');
    } else if (action === "edit" && rest.length === 2) {
      request = { method: "PATCH", path: idPath("/api/a2a/publications/", rest[0])!, body: await readBodyFile(rest[1], options.cwd) };
      render = (body) => log('Updated "' + body.id + '"');
    } else if (action === "remove" && rest.length === 1) {
      request = { method: "DELETE", path: idPath("/api/a2a/publications/", rest[0])! };
      render = () => log('Removed "' + rest[0] + '"');
    }
  }
  if (!request) return bad();

  const ensured = await (options.ensureService ?? (() => ensureGlobalService()))();
  if (!ensured.ok) {
    error(ensured.message);
    return 1;
  }
  const result = await httpRequestJson(options.hostBaseUrl ?? hostBaseUrl(), request.method, request.path, request.body);
  if (result.status < 200 || result.status >= 300) {
    error(apiError(result));
    return 1;
  }
  if (flags.json) log(JSON.stringify(result.body));
  else render(result.body);
  return 0;
}

export async function runA2aCommand(
  args: string[],
  options: {
    cwd: string;
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    error?: (line: string) => void;
    hostBaseUrl?: string;
    ensureService?: () => Promise<EnsureGlobalServiceResult>;
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
  if (MANAGE_COMMANDS.has(sub)) {
    try {
      return await runManageCommand(sub, args.slice(1), parseFlags(args.slice(1)), { ...options, log, error });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  if (sub !== "validate" && sub !== "list" && sub !== "add-caller") {
    error(A2A_USAGE);
    return 1;
  }
  const { config, tokenEnv, positionals, allowRunStage } = parseFlags(args.slice(1));
  if (allowRunStage !== undefined) {
    error(A2A_USAGE);
    return 1;
  }

  if (sub === "add-caller") {
    if (positionals.length !== 1 || !positionals[0]) {
      error(A2A_USAGE);
      return 1;
    }
    const configPath = config ? path.resolve(options.cwd, config)
      : (resolveA2aConfigPath(projectRoot, env) ?? a2aConfigPathFor(projectRoot));
    try {
      const result = await addCaller(configPath, positionals[0], tokenEnv);
      log(JSON.stringify({ ok: true, configPath, callerId: positionals[0], tokenEnv: result.tokenEnv, created: result.created }));
      log('Generated a token for caller "' + positionals[0] + '". Export it before starting the host (or store it in your secrets manager):');
      log("  export " + result.tokenEnv + "=" + result.token);
      log("A running host reads token_env variables only when it starts. For a caller that works without a restart, use `sf a2a caller create`.");
      if (result.created) {
        log("Created " + configPath + " with no publications yet.");
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
      log("Configuration validated locally. Run `sf a2a reload` to make a running host load changes.");
    }
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
