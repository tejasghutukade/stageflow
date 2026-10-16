import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../agent/claudeTools.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { isForeverDeniedSecret, isProviderOrCloudName } from "../runtime/stageEnvironment.js";
import {
  assertSafeMcpUrl,
  extractSecrets,
  McpUrlPolicyError,
} from "./mcpRedaction.js";

/**
 * Host-level MCP state kept under $STAGEFLOW_HOME so it survives image rebuilds:
 * - `mcp/.mcp.json` — servers added from the console, merged over the project `.mcp.json`
 * - `secrets/mcp-secrets.json` — write-only values that fill `${VAR}` in those configs
 */

export type HostMcpError = Error & {
  code: "invalid_server" | "invalid_secret" | "reserved_name";
};

function hostError(code: HostMcpError["code"], message: string): HostMcpError {
  return Object.assign(new Error(message), { code }) as HostMcpError;
}

/**
 * A host-state file exists but cannot be trusted (unparseable, wrong shape, unreadable). It is
 * never read as empty and never overwritten: the owner has to fix or remove the file.
 */
export class McpHostStateError extends Error {
  readonly code = "host_state_corrupt" as const;
  readonly file: string;
  constructor(file: string, detail: string) {
    super(
      `MCP host state file "${file}" ${detail}. Fix or remove it; nothing was changed.`,
    );
    this.name = "McpHostStateError";
    this.file = file;
  }
}

export function isMcpHostStateError(err: unknown): err is McpHostStateError {
  return err instanceof McpHostStateError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hostMcpCatalogPath(home: string = globalStageflowHome()): string {
  return path.join(home, "mcp", ".mcp.json");
}

export function mcpSecretsPath(home: string = globalStageflowHome()): string {
  return path.join(home, "secrets", "mcp-secrets.json");
}

/** Write via a uniquely named tmp file created with the final mode, then rename into place. */
function atomicWrite(file: string, body: string, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, body, { mode, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp never created */
    }
    throw err;
  }
}

function readJsonState(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new McpHostStateError(file, `could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new McpHostStateError(file, "is not valid JSON");
  }
}

/** Servers the console saved. Missing file = empty; a corrupt file throws McpHostStateError. */
export function readHostMcpServers(
  home: string = globalStageflowHome(),
): Record<string, Record<string, unknown>> {
  const file = hostMcpCatalogPath(home);
  const parsed = readJsonState(file);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    throw new McpHostStateError(file, "does not have an mcpServers object");
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (name === STAGEFLOW_MCP_SERVER_NAME) continue;
    if (!isPlainObject(entry)) {
      throw new McpHostStateError(file, `has a non-object entry for "${name}"`);
    }
    out[name] = entry;
  }
  return out;
}

function writeHostMcpServers(
  servers: Record<string, Record<string, unknown>>,
  home: string,
): void {
  atomicWrite(
    hostMcpCatalogPath(home),
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    0o600,
  );
}

/** Host env names an owner explicitly lets agents and probes use to fill `${NAME}`. */
export const MCP_ENV_ALLOW = "STAGEFLOW_MCP_ENV_ALLOW";

export function mcpEnvAllowNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[MCP_ENV_ALLOW];
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && !isForeverDeniedSecret(n));
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_BYTES = 16 * 1024;
const PLACEHOLDER = /\$\{([^}]*)\}/g;

export function assertServerName(name: string): void {
  if (name === STAGEFLOW_MCP_SERVER_NAME) {
    throw hostError("reserved_name", `"${name}" is reserved`);
  }
  if (!SERVER_NAME.test(name)) {
    throw hostError(
      "invalid_server",
      "Server name must be 1-64 letters, digits, '.', '_' or '-'",
    );
  }
}

/**
 * Other tools write remote servers as `serverUrl` / `httpUrl` and mark the transport with `type`.
 * Map those onto our shape: `url`, plus `httpTransport: "sse"` only when SSE is asked for
 * (streamable HTTP is the default and falls back to SSE by itself).
 */
function normaliseSnippet(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  for (const alias of ["serverUrl", "httpUrl"]) {
    if (out.url === undefined && typeof out[alias] === "string") out.url = out[alias];
    delete out[alias];
  }
  const kind = out.type ?? out.transport;
  delete out.type;
  delete out.transport;
  if (kind !== undefined) {
    if (kind === "sse") out.httpTransport = "sse";
    else if (kind === "http" || kind === "streamable-http" || kind === "streamableHttp") {
      if (out.httpTransport === undefined) out.httpTransport = "streamable-http";
    } else if (kind !== "stdio") {
      throw hostError("invalid_server", `Unsupported server type "${String(kind)}" (use stdio, http or sse)`);
    }
  }
  return out;
}

export function validateServerEntry(name: string, rawEntry: unknown): Record<string, unknown> {
  assertServerName(name);
  if (!isPlainObject(rawEntry)) {
    throw hostError("invalid_server", `Server "${name}" must be an object`);
  }
  const entry = normaliseSnippet(rawEntry);
  const hasCommand = Object.hasOwn(entry, "command");
  const hasUrl = Object.hasOwn(entry, "url");
  if (hasCommand === hasUrl) {
    throw hostError(
      "invalid_server",
      `Server "${name}" needs exactly one of "command" (stdio) or "url" (http)`,
    );
  }
  const text = (key: string): string | undefined => {
    const v = entry[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim().length === 0) {
      throw hostError("invalid_server", `"${key}" must be a non-empty string`);
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  if (hasCommand) out.command = text("command");
  if (hasUrl) {
    const url = text("url")!;
    if (!/^(?:https?:\/\/|\$\{)/i.test(url)) {
      throw hostError("invalid_server", `"url" must start with http:// or https://`);
    }
    try {
      assertSafeMcpUrl(url);
    } catch (err) {
      if (err instanceof McpUrlPolicyError) throw hostError("invalid_server", err.message);
      throw err;
    }
    out.url = url;
    const transport = entry.httpTransport;
    if (transport !== undefined) {
      if (transport !== "sse" && transport !== "streamable-http") {
        throw hostError("invalid_server", `"httpTransport" must be "sse" or "streamable-http"`);
      }
      // Streamable HTTP is the default; only SSE needs to be spelled out.
      if (transport === "sse") out.httpTransport = "sse";
    }
  } else if (entry.httpTransport !== undefined) {
    throw hostError("invalid_server", `"httpTransport" only applies to url servers`);
  }
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string")) {
      throw hostError("invalid_server", `"args" must be an array of strings`);
    }
    out.args = entry.args;
  }
  for (const key of ["env", "headers"] as const) {
    const bag = entry[key];
    if (bag === undefined) continue;
    if (!isPlainObject(bag) || Object.values(bag).some((v) => typeof v !== "string")) {
      throw hostError("invalid_server", `"${key}" must map names to strings`);
    }
    if (key === "env" && hasUrl) {
      throw hostError("invalid_server", `"env" only applies to stdio servers`);
    }
    if (key === "headers" && hasCommand) {
      throw hostError("invalid_server", `"headers" only applies to http servers`);
    }
    out[key] = { ...bag };
  }
  const cwd = text("cwd");
  if (cwd !== undefined) out.cwd = cwd;
  assertPlaceholderNamesAllowed(name, out);
  return out;
}

/** Every `${NAME}` / `${NAME:-x}` name in an entry, in order of appearance. */
function placeholderNames(entry: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const m of value.matchAll(PLACEHOLDER)) {
      const inner = (m[1] ?? "").split(":-")[0] ?? "";
      if (SECRET_NAME.test(inner)) found.add(inner);
    }
  };
  scan(entry.command);
  scan(entry.url);
  scan(entry.cwd);
  if (Array.isArray(entry.args)) entry.args.forEach(scan);
  for (const key of ["env", "headers"]) {
    const bag = entry[key];
    if (isPlainObject(bag)) Object.values(bag).forEach(scan);
  }
  return [...found];
}

/**
 * A server entry may not ask for the Host's own credentials: control tokens (forever denied) or
 * provider/cloud credentials, unless the owner put the name in STAGEFLOW_MCP_ENV_ALLOW.
 */
function assertPlaceholderNamesAllowed(server: string, entry: Record<string, unknown>): void {
  const allowed = new Set(mcpEnvAllowNames());
  for (const name of placeholderNames(entry)) {
    if (isForeverDeniedSecret(name)) {
      throw hostError("invalid_server", `Server "${server}" uses \${${name}}, which can never be provided to an MCP server`);
    }
    if (isProviderOrCloudName(name) && !allowed.has(name)) {
      throw hostError(
        "invalid_server",
        `Server "${server}" uses \${${name}}, a provider or cloud credential name. Use a different variable name, or list it in ${MCP_ENV_ALLOW} to allow it.`,
      );
    }
  }
}

function secretNameFor(
  key: string,
  server: string,
  value: string,
  existing: Record<string, string>,
): string {
  const serverPart = server.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  // `Authorization` says nothing about which service the token is for.
  const base =
    key.toLowerCase() === "authorization"
      ? `${serverPart}_TOKEN`
      : key.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "SECRET";
  const prefixed = `${server.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${base}`;
  for (const candidate of [base, prefixed]) {
    if (isForeverDeniedSecret(candidate) || isProviderOrCloudName(candidate)) continue;
    if (existing[candidate] === undefined || existing[candidate] === value) return candidate;
  }
  return `${prefixed}_2`;
}

/** Placeholders (`${NAME}`) without a `:-default`, in the order they appear. */
export function requiredVars(entry: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value !== "string") return;
    for (const m of value.matchAll(PLACEHOLDER)) {
      const inner = m[1] ?? "";
      if (SECRET_NAME.test(inner)) found.add(inner);
    }
  };
  scan(entry.command);
  scan(entry.url);
  scan(entry.cwd);
  if (Array.isArray(entry.args)) entry.args.forEach(scan);
  for (const key of ["env", "headers"]) {
    const bag = entry[key];
    if (isPlainObject(bag)) Object.values(bag).forEach(scan);
  }
  return [...found];
}

export type SaveServerResult = {
  name: string;
  /** Names of secrets created from literal tokens in the pasted config. */
  secretsStored: string[];
};

/**
 * Save one server. Literal tokens in env, headers, url (query/userinfo) and args are moved into the
 * secrets store and replaced with `${NAME}`, so the catalog file never holds a secret.
 *
 * Both files are read first (a corrupt one aborts before anything is written). The secrets file is
 * written before the catalog and put back if the catalog write fails.
 */
export function saveHostMcpServer(
  name: string,
  entry: unknown,
  home: string = globalStageflowHome(),
): SaveServerResult {
  const validated = validateServerEntry(name, entry);
  const secrets = readMcpSecrets(home);
  const servers = readHostMcpServers(home);
  const { entry: stored, secrets: pending } = extractSecrets(
    validated,
    (key, value, taken) => secretNameFor(key, name, value, taken),
    secrets,
  );
  for (const secretName of Object.keys(pending)) assertUsableSecret(secretName, pending[secretName]!);
  servers[name] = stored;
  const names = Object.keys(pending);
  if (names.length === 0) {
    writeHostMcpServers(servers, home);
    return { name, secretsStored: [] };
  }
  const secretsFile = mcpSecretsPath(home);
  const previous = existsSync(secretsFile) ? readFileSync(secretsFile, "utf8") : undefined;
  writeMcpSecretsFile({ ...secrets, ...pending }, home);
  try {
    writeHostMcpServers(servers, home);
  } catch (err) {
    try {
      if (previous === undefined) rmSync(secretsFile, { force: true });
      else atomicWrite(secretsFile, previous, 0o600);
    } catch {
      /* best effort: the original error is the one to report */
    }
    throw err;
  }
  return { name, secretsStored: names };
}

export function removeHostMcpServer(
  name: string,
  home: string = globalStageflowHome(),
): boolean {
  const servers = readHostMcpServers(home);
  if (!Object.hasOwn(servers, name)) return false;
  delete servers[name];
  writeHostMcpServers(servers, home);
  return true;
}

/** Pull `{ name: entry }` out of pasted JSON: a full `.mcp.json`, a bare map, or `{ mcpServers }`. */
export function parsePastedMcpJson(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw hostError("invalid_server", "Pasted JSON must be an object");
  }
  const inner = isPlainObject(raw.mcpServers) ? raw.mcpServers : raw;
  if (Object.hasOwn(inner, "command") || Object.hasOwn(inner, "url")) {
    throw hostError(
      "invalid_server",
      'Wrap a single server as { "mcpServers": { "name": { … } } } so it has a name',
    );
  }
  if (Object.keys(inner).length === 0) {
    throw hostError("invalid_server", "No servers found in the pasted JSON");
  }
  return inner;
}

export function readMcpSecrets(home: string = globalStageflowHome()): Record<string, string> {
  const file = mcpSecretsPath(home);
  const parsed = readJsonState(file);
  if (parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new McpHostStateError(file, "is not a JSON object of secret names to values");
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

function writeMcpSecretsFile(secrets: Record<string, string>, home: string): void {
  atomicWrite(mcpSecretsPath(home), `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
}

function assertUsableSecret(name: string, value: string): void {
  if (!SECRET_NAME.test(name) || isForeverDeniedSecret(name)) {
    throw hostError("invalid_secret", `"${name}" is not a usable secret name`);
  }
  if (value.length === 0 || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw hostError("invalid_secret", "Secret value must be 1 byte to 16 KB");
  }
}

export function setMcpSecret(
  name: string,
  value: string,
  home: string = globalStageflowHome(),
): void {
  assertUsableSecret(name, value);
  const secrets = readMcpSecrets(home);
  secrets[name] = value;
  writeMcpSecretsFile(secrets, home);
}

export function deleteMcpSecret(
  name: string,
  home: string = globalStageflowHome(),
): boolean {
  const secrets = readMcpSecrets(home);
  if (!Object.hasOwn(secrets, name)) return false;
  delete secrets[name];
  writeMcpSecretsFile(secrets, home);
  return true;
}

/** Secret names only; values never leave the store through the API. */
export function listMcpSecretNames(home: string = globalStageflowHome()): string[] {
  return Object.keys(readMcpSecrets(home)).sort();
}
