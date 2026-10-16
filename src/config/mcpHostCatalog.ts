import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../agent/claudeTools.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { isForeverDeniedSecret } from "../runtime/stageEnvironment.js";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hostMcpCatalogPath(home: string = globalStageflowHome()): string {
  return path.join(home, "mcp", ".mcp.json");
}

export function mcpSecretsPath(home: string = globalStageflowHome()): string {
  return path.join(home, "secrets", "mcp-secrets.json");
}

function atomicWrite(file: string, body: string, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Servers the console saved; a missing or unreadable file is an empty catalog. */
export function readHostMcpServers(
  home: string = globalStageflowHome(),
): Record<string, Record<string, unknown>> {
  const file = hostMcpCatalogPath(home);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      if (isPlainObject(entry) && name !== STAGEFLOW_MCP_SERVER_NAME) out[name] = entry;
    }
    return out;
  } catch {
    return {};
  }
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

/** Keys that carry a literal secret in env/headers, or a value that looks like a token. */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|auth|credential|bearer|private[-_]?key/i;
const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|AIza|glpat-|npm_|pk_live_|sk_live_|ya29\.)/;

function literalLooksSecret(key: string, value: string): boolean {
  if (value.length === 0 || value.includes("${")) return false;
  const bare = value.replace(/^(?:Bearer|Basic|Token)\s+/i, "");
  if (TOKEN_PREFIX.test(bare)) return true;
  if (SECRET_KEY.test(key)) return true;
  return bare.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare);
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
  return out;
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
    if (isForeverDeniedSecret(candidate)) continue;
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
 * Save one server. Literal tokens in env/headers are moved into the secrets store and replaced
 * with `${NAME}`, so the catalog file never holds a secret.
 */
export function saveHostMcpServer(
  name: string,
  entry: unknown,
  home: string = globalStageflowHome(),
): SaveServerResult {
  const valid = validateServerEntry(name, entry);
  const secrets = readMcpSecrets(home);
  const stored: string[] = [];
  const pending: Record<string, string> = {};
  for (const key of ["env", "headers"] as const) {
    const bag = valid[key] as Record<string, string> | undefined;
    if (!bag) continue;
    for (const [field, value] of Object.entries(bag)) {
      if (!literalLooksSecret(field, value)) continue;
      const prefix = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? "";
      const secretValue = value.slice(prefix.length);
      const secretName = secretNameFor(field, name, secretValue, { ...secrets, ...pending });
      pending[secretName] = secretValue;
      bag[field] = `${prefix}\${${secretName}}`;
      stored.push(secretName);
    }
  }
  const servers = readHostMcpServers(home);
  servers[name] = valid;
  for (const [secretName, value] of Object.entries(pending)) setMcpSecret(secretName, value, home);
  writeHostMcpServers(servers, home);
  return { name, secretsStored: stored };
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
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isPlainObject(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && SECRET_NAME.test(name)) out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function setMcpSecret(
  name: string,
  value: string,
  home: string = globalStageflowHome(),
): void {
  if (!SECRET_NAME.test(name) || isForeverDeniedSecret(name)) {
    throw hostError("invalid_secret", `"${name}" is not a usable secret name`);
  }
  if (value.length === 0 || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw hostError("invalid_secret", "Secret value must be 1 byte to 16 KB");
  }
  const secrets = readMcpSecrets(home);
  secrets[name] = value;
  atomicWrite(mcpSecretsPath(home), `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
}

export function deleteMcpSecret(
  name: string,
  home: string = globalStageflowHome(),
): boolean {
  const secrets = readMcpSecrets(home);
  if (!Object.hasOwn(secrets, name)) return false;
  delete secrets[name];
  atomicWrite(mcpSecretsPath(home), `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
  return true;
}

/** Secret names only; values never leave the store through the API. */
export function listMcpSecretNames(home: string = globalStageflowHome()): string[] {
  return Object.keys(readMcpSecrets(home)).sort();
}
