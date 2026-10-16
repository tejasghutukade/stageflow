import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
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
  | "flow_failed";

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

/** Make the Host's file key available to the adapter, creating it on first use. */
export function ensureOAuthFileKey(home: string = globalStageflowHome()): void {
  if ((process.env[OAUTH_FILE_KEY_ENV] ?? "").trim() !== "") return;
  const file = oauthKeyPath(home);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      // Another process created it first; read theirs.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    chmodSync(file, 0o600);
  }
  process.env[OAUTH_FILE_KEY_ENV] = readFileSync(file, "utf8").trim();
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

type RemoteServer = { url: string; definition: Record<string, unknown> };

async function remoteServer(projectRoot: string, name: string): Promise<RemoteServer> {
  let catalog;
  try {
    catalog = await loadMcpCatalog(projectRoot, { host: true });
  } catch (err) {
    if (err instanceof StageMcpError) throw new McpOAuthError(`Server "${name}" not found`, "not_found");
    throw err;
  }
  if (!Object.hasOwn(catalog.servers, name)) {
    throw new McpOAuthError(`Server "${name}" not found`, "not_found");
  }
  if (typeof catalog.servers[name]?.url !== "string") {
    throw new McpOAuthError(`Server "${name}" is a local command; OAuth applies to URL servers`, "not_http");
  }
  const resolved = await resolveStageMcpServers({
    projectRoot,
    allowlist: [name],
    env: process.env,
    host: true,
  });
  const entry = resolved[name] ?? {};
  return { url: String(entry.url), definition: { ...entry, auth: "oauth" } };
}

function wrapFlowError(err: unknown): never {
  if (err instanceof McpOAuthError) throw err;
  const message = err instanceof Error ? err.message : String(err);
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
  const { url, definition } = await remoteServer(projectRoot, name);
  try {
    const flow = await loadFlow();
    return await flow.startAuth(name, url, definition, STORAGE);
  } catch (err) {
    return wrapFlowError(err);
  }
}

/** Finish sign-in from the redirect URL the browser landed on (or a bare code). */
export async function completeMcpOAuth(name: string, input: string): Promise<McpOAuthStatus> {
  prepare();
  try {
    const flow = await loadFlow();
    return await flow.completeAuthFromInput(name, input, STORAGE);
  } catch (err) {
    return wrapFlowError(err);
  }
}

export async function mcpOAuthStatus(name: string): Promise<McpOAuthStatus> {
  prepare();
  try {
    const flow = await loadFlow();
    return await flow.getAuthStatus(name, STORAGE);
  } catch (err) {
    return wrapFlowError(err);
  }
}

export async function removeMcpOAuth(name: string): Promise<void> {
  prepare();
  try {
    const flow = await loadFlow();
    await flow.removeAuth(name, STORAGE);
  } catch (err) {
    wrapFlowError(err);
  }
}
