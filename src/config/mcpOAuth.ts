import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import { assertServerName, readMcpSecrets } from "./mcpHostCatalog.js";
import { assertSafeMcpUrl, collectSecretValues, McpUrlPolicyError, oauthDefinition, scrubText } from "./mcpRedaction.js";
import {
  loadMcpCatalog,
  resolveStageMcpServers,
  StageMcpError,
} from "./resolveStageMcpServers.js";

/**
 * OAuth sign-in for remote MCP servers, run through pi-mcp-adapter's own flow.
 *
 * Tokens live in the adapter's encrypted-file store under the Host's Pi agent dir
 * (`$STAGEFLOW_HOME/agent/mcp-oauth-encrypted`) and are keyed by a Host-generated key, so it works
 * in a container with no OS keyring. The adapter refuses a symlinked store, and stage attempts run
 * with a sealed per-attempt agent dir, so signed-in servers are available to agents and Check, not
 * to pipeline stages.
 */

export const OAUTH_FILE_KEY_ENV = "PI_MCP_ADAPTER_OAUTH_FILE_KEY";

export type McpOAuthStatus = "authenticated" | "expired" | "not_authenticated";

export type McpOAuthErrorCode =
  | "not_found"
  | "not_http"
  | "store_unavailable"
  | "flow_failed"
  | "invalid_input"
  | "blocked_url"
  | "host_state_corrupt";

/** HTTP status for each OAuth error code; the routes use this one table. */
export const MCP_OAUTH_HTTP_STATUS: Record<McpOAuthErrorCode, number> = {
  not_found: 404,
  not_http: 400,
  flow_failed: 400,
  invalid_input: 400,
  blocked_url: 400,
  store_unavailable: 500,
  host_state_corrupt: 409,
};

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  constructor(message: string, code: McpOAuthErrorCode) {
    super(message);
    this.name = "McpOAuthError";
    this.code = code;
  }
}

export function oauthKeyPath(home: string = globalStageflowHome()): string {
  return path.join(home, "secrets", "mcp-oauth.key");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readKeyWithRetry(file: string): string {
  for (let i = 0; i < 20; i += 1) {
    const value = readFileSync(file, "utf8").trim();
    if (value !== "") return value;
    sleepSync(25);
  }
  throw new Error(`OAuth key file "${file}" is empty; remove it so a new key can be generated`);
}

/**
 * Make the Host's file key available to the adapter, creating it on first use. The key is written
 * to a private tmp file and linked into place, so a concurrent reader never sees a half-written key.
 */
export function ensureOAuthFileKey(home: string = globalStageflowHome()): void {
  if ((process.env[OAUTH_FILE_KEY_ENV] ?? "").trim() !== "") return;
  const file = oauthKeyPath(home);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      linkSync(tmp, file);
    } catch (err) {
      // Another process linked its key first; read theirs.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
  }
  process.env[OAUTH_FILE_KEY_ENV] = readKeyWithRetry(file);
}

/** Everything the adapter needs before it can read or write OAuth tokens in this process. */
export function prepareMcpOAuth(): void {
  ensureOAuthFileKey(globalStageflowHome());
}

type AuthFlowModule = {
  startAuth: (
    serverName: string,
    serverUrl: string,
    definition?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ authorizationUrl: string }>;
  completeAuthFromInput: (
    serverName: string,
    input: string,
    options?: Record<string, unknown>,
  ) => Promise<McpOAuthStatus>;
  getAuthStatus: (serverName: string, options?: Record<string, unknown>) => Promise<McpOAuthStatus>;
  removeAuth: (serverName: string, options?: Record<string, unknown>) => Promise<void>;
};

let cachedFlow: Promise<AuthFlowModule> | undefined;

/**
 * The adapter only exports token reads publicly; the interactive flow lives in an internal module.
 * It is loaded by path behind this one function, and `tests/mcp.oauth.flow.test.ts` fails if the
 * names we rely on go away.
 */
async function loadFlow(): Promise<AuthFlowModule> {
  cachedFlow ??= (async () => {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve("pi-mcp-adapter/oauth"));
    const { createJiti } = await import("jiti/static");
    const jiti = createJiti(import.meta.url, {
      fsCache: path.join(globalStageflowHome(), "cache", "jiti"),
    });
    return (await jiti.import(path.join(pkgDir, "mcp-auth-flow.ts"))) as AuthFlowModule;
  })();
  try {
    return await cachedFlow;
  } catch (err) {
    cachedFlow = undefined;
    throw err;
  }
}

export function resetMcpOAuthFlowCacheForTests(): void {
  cachedFlow = undefined;
}

const STORAGE = { authStorageOptions: { credentialStore: "encrypted-file" } } as const;

type RemoteServer = { url: string; definition: Record<string, unknown>; secrets: string[] };

function consoleSecretValues(): string[] {
  try {
    return Object.values(readMcpSecrets());
  } catch {
    return [];
  }
}

/** Confirm `name` is a known URL server; no secrets are resolved. */
async function requireRemoteEntry(projectRoot: string, name: string): Promise<Record<string, unknown>> {
  try {
    assertServerName(name);
  } catch {
    throw new McpOAuthError(`Server "${name}" not found`, "not_found");
  }
  let catalog;
  try {
    catalog = await loadMcpCatalog(projectRoot, { scope: { kind: "validate" } });
  } catch (err) {
    if (err instanceof StageMcpError) {
      if (err.code === "host_state_corrupt") throw new McpOAuthError(err.message, "host_state_corrupt");
      throw new McpOAuthError(`Server "${name}" not found`, "not_found");
    }
    throw err;
  }
  if (!Object.hasOwn(catalog.servers, name)) {
    throw new McpOAuthError(`Server "${name}" not found`, "not_found");
  }
  const entry = catalog.servers[name]!;
  if (typeof entry.url !== "string") {
    throw new McpOAuthError(`Server "${name}" is a local command; OAuth applies to URL servers`, "not_http");
  }
  return entry;
}

/** Name must be a known URL server when a project root is given (the routes always give one). */
async function checkKnown(name: string, projectRoot: string | undefined): Promise<void> {
  if (projectRoot !== undefined) await requireRemoteEntry(projectRoot, name);
}

async function remoteServer(projectRoot: string, name: string): Promise<RemoteServer> {
  await requireRemoteEntry(projectRoot, name);
  let resolved;
  try {
    resolved = await resolveStageMcpServers({
      projectRoot,
      allowlist: [name],
      env: {},
      scope: { kind: "agent" },
    });
  } catch (err) {
    if (err instanceof StageMcpError && err.code === "host_state_corrupt") {
      throw new McpOAuthError(err.message, "host_state_corrupt");
    }
    if (err instanceof StageMcpError && err.code === "invalid_config") {
      throw new McpOAuthError(err.message, "blocked_url");
    }
    throw err;
  }
  const entry = resolved[name] ?? {};
  const url = String(entry.url);
  try {
    assertSafeMcpUrl(url);
  } catch (err) {
    if (err instanceof McpUrlPolicyError) throw new McpOAuthError(err.message, "blocked_url");
    throw err;
  }
  return { url, definition: { ...oauthDefinition(entry), auth: "oauth" }, secrets: collectSecretValues(entry) };
}

function wrapFlowError(err: unknown, extraSecrets: readonly string[] = []): never {
  if (err instanceof McpOAuthError) throw err;
  const raw = err instanceof Error ? err.message : String(err);
  const message = scrubText(raw, [...extraSecrets, ...consoleSecretValues()]);
  if (/OAUTH_FILE_KEY|credential store/i.test(message)) {
    throw new McpOAuthError(message, "store_unavailable");
  }
  throw new McpOAuthError(message, "flow_failed");
}

function prepare(): void {
  try {
    prepareMcpOAuth();
  } catch (err) {
    throw new McpOAuthError(
      `Could not prepare the OAuth store: ${err instanceof Error ? err.message : String(err)}`,
      "store_unavailable",
    );
  }
}

/** Begin sign-in; returns the link to open in a browser. */
export async function startMcpOAuth(
  projectRoot: string,
  name: string,
): Promise<{ authorizationUrl: string }> {
  prepare();
  const { url, definition, secrets } = await remoteServer(projectRoot, name);
  try {
    const flow = await loadFlow();
    return await flow.startAuth(name, url, definition, STORAGE);
  } catch (err) {
    return wrapFlowError(err, secrets);
  }
}

const MAX_OAUTH_INPUT = 4096;

/** The pasted redirect address, or a bare authorization code of sane length. */
export function assertOAuthInput(input: string): void {
  const value = input.trim();
  const looksLikeUrl = /^https?:\/\/\S+$/i.test(value);
  const looksLikeCode = /^[A-Za-z0-9._~+/=-]{4,512}$/.test(value);
  if (value.length > MAX_OAUTH_INPUT || !(looksLikeUrl || looksLikeCode)) {
    throw new McpOAuthError(
      "Paste the full address from the browser (or the authorization code)",
      "invalid_input",
    );
  }
}

/** Finish sign-in from the redirect URL the browser landed on (or a bare code). */
export async function completeMcpOAuth(
  name: string,
  input: string,
  projectRoot?: string,
): Promise<McpOAuthStatus> {
  await checkKnown(name, projectRoot);
  assertOAuthInput(input);
  prepare();
  try {
    const flow = await loadFlow();
    return await flow.completeAuthFromInput(name, input, STORAGE);
  } catch (err) {
    return wrapFlowError(err);
  }
}

export async function mcpOAuthStatus(name: string, projectRoot?: string): Promise<McpOAuthStatus> {
  await checkKnown(name, projectRoot);
  prepare();
  try {
    const flow = await loadFlow();
    return await flow.getAuthStatus(name, STORAGE);
  } catch (err) {
    return wrapFlowError(err);
  }
}

export async function removeMcpOAuth(name: string, projectRoot?: string): Promise<void> {
  await checkKnown(name, projectRoot);
  prepare();
  try {
    const flow = await loadFlow();
    await flow.removeAuth(name, STORAGE);
  } catch (err) {
    wrapFlowError(err);
  }
}
