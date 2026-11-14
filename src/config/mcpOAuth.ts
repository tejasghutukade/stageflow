import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { globalStageflowHome } from "../project/globalHome.js";
import { assertServerName, readMcpSecrets } from "./mcpHostCatalog.js";
import { assertSafeMcpUrl, collectSecretValues, isBlockedMcpHost, McpUrlPolicyError, oauthDefinition, scrubText } from "./mcpRedaction.js";
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
 * in a container with no OS keyring. The adapter refuses a symlinked store. A pipeline stage does
 * not receive that store. The host calls a signed-in console server on the stage's behalf.
 */

export const OAUTH_FILE_KEY_ENV = "PI_MCP_ADAPTER_OAUTH_FILE_KEY";
export const MCP_AUTH_CACHE_DISABLE_ENV = "PI_MCP_ADAPTER_DISABLE_AUTH_CACHE";

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
  process.env[MCP_AUTH_CACHE_DISABLE_ENV] = "1";
  ensureOAuthFileKey(globalStageflowHome());
}

/** Encrypted-file reads follow `PI_CODING_AGENT_DIR`. Without it the adapter uses the OS keyring. */
export function useHostMcpGrantEnv(): void {
  process.env[MCP_AUTH_CACHE_DISABLE_ENV] = "1";
  if ((process.env.PI_CODING_AGENT_DIR ?? "").trim() === "") {
    process.env.PI_CODING_AGENT_DIR = path.join(globalStageflowHome(), "agent");
  }
  prepareMcpOAuth();
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

export type McpGrantTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

type GrantProvider = OAuthClientProvider & { deactivate: () => void };

type AdapterBundle = {
  flow: AuthFlowModule;
  beginOAuthRevocation: (serverName: string) => () => void;
  getAuthEntry: (
    serverName: string,
    options?: { credentialStore?: "encrypted-file" },
  ) => { serverUrl?: string } | undefined;
  getAuthForUrl: (
    serverName: string,
    serverUrl: string,
    options?: { credentialStore?: "encrypted-file" },
  ) => { tokens?: McpGrantTokens } | undefined;
  McpOAuthProvider: new (
    serverName: string,
    serverUrl: string,
    config: Record<string, never>,
    callbacks: { onRedirect: (authorizationUrl: URL) => Promise<void> },
    storageOptions: { credentialStore: "encrypted-file" },
  ) => GrantProvider;
};

let cachedBundle: Promise<AdapterBundle> | undefined;

/**
 * The adapter only exports token reads publicly; the interactive flow lives in an internal module.
 * It is loaded by path behind this one function, and `tests/mcp.oauth.flow.test.ts` fails if the
 * names we rely on go away.
 */
async function loadBundle(): Promise<AdapterBundle> {
  cachedBundle ??= (async () => {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve("pi-mcp-adapter/oauth"));
    const { createJiti } = await import("jiti/static");
    const jiti = createJiti(import.meta.url, {
      fsCache: path.join(globalStageflowHome(), "cache", "jiti"),
    });
    const [flow, auth, provider] = await Promise.all([
      jiti.import(path.join(pkgDir, "mcp-auth-flow.ts")) as Promise<AuthFlowModule>,
      jiti.import(path.join(pkgDir, "mcp-auth.ts")) as Promise<Pick<AdapterBundle, "beginOAuthRevocation" | "getAuthEntry" | "getAuthForUrl">>,
      jiti.import(path.join(pkgDir, "mcp-oauth-provider.ts")) as Promise<Pick<AdapterBundle, "McpOAuthProvider">>,
    ]);
    return {
      flow,
      beginOAuthRevocation: auth.beginOAuthRevocation,
      getAuthEntry: auth.getAuthEntry,
      getAuthForUrl: auth.getAuthForUrl,
      McpOAuthProvider: provider.McpOAuthProvider,
    };
  })();
  try {
    return await cachedBundle;
  } catch (err) {
    cachedBundle = undefined;
    throw err;
  }
}

async function loadFlow(): Promise<AuthFlowModule> {
  return (await loadBundle()).flow;
}

export async function loadMcpOAuthAdapter(): Promise<AdapterBundle> {
  useHostMcpGrantEnv();
  return loadBundle();
}

export function resetMcpOAuthFlowCacheForTests(): void {
  cachedBundle = undefined;
}

const STORAGE = { authStorageOptions: { credentialStore: "encrypted-file" } } as const;

const grantTails = new Map<string, Promise<void>>();

function grantAccount(name: string): string {
  return `sha256-${createHash("sha256").update(name, "utf8").digest("hex")}`;
}

function grantLockRoot(name: string): string {
  return path.join(globalStageflowHome(), "mcp-oauth-locks", grantAccount(name));
}

function grantCredentialsPath(name: string): string {
  const agent = (process.env.PI_CODING_AGENT_DIR ?? "").trim();
  return path.join(agent, "mcp-oauth-encrypted", grantAccount(name), "credentials.json");
}

function signInBindingPath(name: string): string {
  return path.join(grantLockRoot(name), "signin.json");
}

function epochPath(name: string): string {
  return path.join(grantLockRoot(name), "epoch");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireGrantFileLock(name: string): Promise<void> {
  const root = grantLockRoot(name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "lock");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = 0;
      try {
        holder = Number.parseInt(await readFile(path.join(lock, "pid"), "utf8"), 10);
      } catch {
        holder = 0;
      }
      if (holder > 0 && holder !== process.pid && !pidAlive(holder)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the MCP grant lock for ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function releaseGrantFileLock(name: string): Promise<void> {
  await rm(path.join(grantLockRoot(name), "lock"), { recursive: true, force: true });
}

/** One lock per server, shared by every host process on this data directory. */
export async function withMcpGrantLock<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
  const key = grantLockRoot(serverName);
  const prev = grantTails.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    await acquireGrantFileLock(serverName);
    try {
      return await fn();
    } finally {
      await releaseGrantFileLock(serverName);
    }
  });
  grantTails.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export function resetMcpGrantLocksForTests(): void {
  grantTails.clear();
}

function unlinkGrantFiles(name: string): void {
  unlinkSync(grantCredentialsPath(name));
}

function unlinkGrantFilesSafe(name: string): void {
  try {
    unlinkGrantFiles(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    unlinkSync(signInBindingPath(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function bumpGrantEpoch(name: string): void {
  const root = grantLockRoot(name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(epochPath(name), randomBytes(8).toString("hex"), { mode: 0o600 });
}

export function readMcpGrantEpoch(name: string): string {
  try {
    return readFileSync(epochPath(name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** A refresh that wrote after sign-out started drops that write. */
export function discardMcpGrantIfRevoked(name: string, epoch: string): void {
  if (readMcpGrantEpoch(name) === epoch) return;
  unlinkGrantFilesSafe(name);
}

export async function readMcpGrantTokens(name: string, url: string): Promise<McpGrantTokens | undefined> {
  useHostMcpGrantEnv();
  const entry = (await loadBundle()).getAuthForUrl(name, url, STORAGE.authStorageOptions);
  return entry?.tokens;
}

export async function mcpGrantSecretValues(name: string, url: string): Promise<string[]> {
  const values: string[] = [];
  const key = (process.env[OAUTH_FILE_KEY_ENV] ?? "").trim();
  if (key.length >= 8) values.push(key);
  try {
    const tokens = await readMcpGrantTokens(name, url);
    if (tokens?.accessToken && tokens.accessToken.length >= 8) values.push(tokens.accessToken);
    if (tokens?.refreshToken && tokens.refreshToken.length >= 8) values.push(tokens.refreshToken);
  } catch {
    return values;
  }
  return values;
}

export async function mcpStoredGrantStatus(name: string): Promise<McpOAuthStatus | "unavailable"> {
  if ((process.env.PI_CODING_AGENT_DIR ?? "").trim() === "") {
    process.env.PI_CODING_AGENT_DIR = path.join(globalStageflowHome(), "agent");
  }
  // No credential file means signed out. Do not create a key, refresh, or open a connection.
  if (!existsSync(grantCredentialsPath(name))) return "not_authenticated";
  useHostMcpGrantEnv();
  try {
    return await mcpOAuthStatus(name);
  } catch (err) {
    if (err instanceof McpOAuthError && err.code === "store_unavailable") return "unavailable";
    throw err;
  }
}

type SignInBinding = { issuer: string; tokenEndpoint: string };

function readSignInBinding(name: string): SignInBinding | undefined {
  try {
    const parsed = JSON.parse(readFileSync(signInBindingPath(name), "utf8")) as Partial<SignInBinding>;
    if (typeof parsed.issuer !== "string" || typeof parsed.tokenEndpoint !== "string") return undefined;
    return { issuer: parsed.issuer, tokenEndpoint: parsed.tokenEndpoint };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function issuersMatch(left: string, right: string): boolean {
  return left === right || left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

function endpointsMatch(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

export function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    const record = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string") codes.push(record.code);
    if (typeof record.name === "string") codes.push(record.name);
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) walk(item);
    }
    walk(record.cause);
  };
  walk(error);
  return codes;
}

export function isMcpConnectFailure(error: unknown): boolean {
  const codes = errorCodes(error);
  if (codes.some((code) => ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "TimeoutError"].includes(code))) {
    return true;
  }
  return codes.some((code) => /CERT_|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/.test(code));
}

export async function discoverMcpAuthorization(
  serverUrl: string,
): Promise<{ issuer: string; tokenEndpoint: string } | undefined> {
  const resource = new URL(serverUrl);
  const signal = AbortSignal.timeout(30_000);
  const prmUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource.origin);
  const prmRes = await fetch(prmUrl, { signal });
  if (!prmRes.ok) return undefined;
  const prm = (await prmRes.json()) as { authorization_servers?: unknown };
  const authorizationServer = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : undefined;
  if (typeof authorizationServer !== "string") return undefined;
  let authorizationServerUrl: URL;
  try {
    authorizationServerUrl = new URL(authorizationServer);
  } catch {
    return undefined;
  }
  if (isBlockedMcpHost(authorizationServerUrl.hostname)) return undefined;
  const metaRes = await fetch(new URL("/.well-known/oauth-authorization-server", authorizationServerUrl), { signal });
  if (!metaRes.ok) return undefined;
  const meta = (await metaRes.json()) as { issuer?: unknown; token_endpoint?: unknown };
  if (typeof meta.issuer !== "string" || typeof meta.token_endpoint !== "string") return undefined;
  return { issuer: meta.issuer, tokenEndpoint: meta.token_endpoint };
}

export async function mcpGrantRefreshAllowed(
  name: string,
  url: string,
): Promise<"ok" | "needs_auth" | "connect_failed"> {
  const binding = readSignInBinding(name);
  if (!binding) return "needs_auth";
  let discovered: { issuer: string; tokenEndpoint: string } | undefined;
  try {
    discovered = await discoverMcpAuthorization(url);
  } catch (err) {
    if (isMcpConnectFailure(err) || (err instanceof Error && err.name === "TimeoutError")) return "connect_failed";
    throw err;
  }
  if (!discovered) return "connect_failed";
  if (!issuersMatch(binding.issuer, discovered.issuer) || !endpointsMatch(binding.tokenEndpoint, discovered.tokenEndpoint)) {
    return "needs_auth";
  }
  return "ok";
}

async function rememberMcpGrantSignIn(name: string, url: string): Promise<boolean> {
  return withMcpGrantLock(name, async () => {
    if (!existsSync(grantCredentialsPath(name))) return false;
    const discovered = await discoverMcpAuthorization(url);
    if (!discovered) return false;
    const root = grantLockRoot(name);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(signInBindingPath(name), JSON.stringify(discovered), { mode: 0o600 });
    return true;
  });
}

/** Sign-out and connection removal. A write that lost the race is removed again. */
export async function revokeMcpOAuthGrant(name: string): Promise<void> {
  useHostMcpGrantEnv();
  let release = (): void => {};
  try {
    release = (await loadBundle()).beginOAuthRevocation(name);
  } catch {
    release = () => {};
  }
  try {
    bumpGrantEpoch(name);
    await withMcpGrantLock(name, async () => {
      unlinkGrantFilesSafe(name);
    });
    await withMcpGrantLock(name, async () => {
      unlinkGrantFilesSafe(name);
    });
  } finally {
    release();
  }
}

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
    const status = await flow.completeAuthFromInput(name, input, STORAGE);
    const entry = (await loadBundle()).getAuthEntry(name, STORAGE.authStorageOptions);
    if (entry?.serverUrl) {
      const remembered = await rememberMcpGrantSignIn(name, entry.serverUrl);
      if (!remembered) {
        await revokeMcpOAuthGrant(name);
        return "not_authenticated";
      }
    }
    return status;
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
  await revokeMcpOAuthGrant(name);
  try {
    const flow = await loadFlow();
    await flow.removeAuth(name, STORAGE);
  } catch (err) {
    wrapFlowError(err);
  }
}
