import {
  auth,
  Client,
  InsufficientScopeError,
  OAuthError,
  OAuthErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { formatToolName } from "pi-mcp-adapter/types";
import {
  type FrozenHostLoginServer,
} from "../config/hostLoginMcp.js";
import {
  discardMcpGrantIfRevoked,
  errorCodes,
  isMcpConnectFailure,
  loadMcpOAuthAdapter,
  mcpGrantRefreshAllowed,
  mcpGrantSecretValues,
  mcpStoredGrantStatus,
  OAUTH_FILE_KEY_ENV,
  prepareMcpOAuth,
  readMcpGrantEpoch,
  readMcpGrantTokens,
  withMcpGrantLock,
  type McpGrantTokens,
} from "../config/mcpOAuth.js";
import {
  partitionHostLogin,
  resolveStageMcpServersDetailed,
} from "../config/resolveStageMcpServers.js";
import type { StageMcpTools } from "../types/stage.js";
import type { DerivedBindingKind } from "./stageRoots.js";

export const STAGE_MCP_NATIVE_TOOLS_REASON =
  "Cursor models run their own file and shell tools outside this agent's grants and approvals. Choose another provider's model, or set STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1 on the Host to accept that.";

export type StageMcpAllowlistStage = {
  mcp?: readonly string[];
  mcp_tools?: StageMcpTools;
  secrets?: readonly { name: string }[];
};

export type StageMcpCallView =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

export type StageMcpListedTool = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type StageMcpListView =
  | { ok: true; tools: StageMcpListedTool[] }
  | { ok: false; code: string; message: string };

export type StageMcpUpstreamTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type StageMcpUpstream = {
  list(
    server: FrozenHostLoginServer,
    signal: AbortSignal,
  ): Promise<{ ok: true; tools: StageMcpUpstreamTool[] } | { ok: false; code: string; message: string }>;
  call(
    server: FrozenHostLoginServer,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<StageMcpCallView>;
};

const NEEDS_AUTH_SENTINEL = "stageflow_grant_needs_auth";
const CONNECT_FAILED_SENTINEL = "stageflow_grant_connect_failed";

class StageMcpGrantError extends Error {
  constructor(readonly grantCode: "needs_auth" | "insufficient_scope" | "connect_failed") {
    super(grantCode);
    this.name = "StageMcpGrantError";
  }
}

function needsAuthSentinel(): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidScope, NEEDS_AUTH_SENTINEL);
}

function connectFailedSentinel(): OAuthError {
  return new OAuthError(OAuthErrorCode.AccessDenied, CONNECT_FAILED_SENTINEL);
}

function refreshTokenFromBody(body: BodyInit | null | undefined): string | undefined {
  const text = body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : undefined;
  if (text === undefined || !text.includes("grant_type=refresh_token")) return undefined;
  return new URLSearchParams(text).get("refresh_token") ?? undefined;
}

function tokenResponse(tokens: McpGrantTokens): Response {
  const expiresIn = tokens.expiresAt !== undefined
    ? Math.max(1, Math.floor(tokens.expiresAt - Date.now() / 1000))
    : 3600;
  return new Response(JSON.stringify({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    ...(tokens.refreshToken !== undefined ? { refresh_token: tokens.refreshToken } : {}),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function isConnRefused(error: unknown): boolean {
  return errorCodes(error).includes("ECONNREFUSED");
}

function isTimeout(error: unknown): boolean {
  const codes = errorCodes(error);
  return codes.some((code) => code === "TimeoutError" || code === "ETIMEDOUT" || code.startsWith("UND_ERR_"));
}

function createGrantFetch(server: FrozenHostLoginServer): FetchLike {
  return async (input, init) => {
    const posted = refreshTokenFromBody(init?.body);
    if (posted === undefined) return fetch(input, init);
    const send = async (): Promise<Response> => {
      const timeout = AbortSignal.timeout(30_000);
      const signal = init?.signal !== undefined && init.signal !== null
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      try {
        return await fetch(input, { ...init, signal });
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        if (timeout.aborted || isTimeout(err)) {
          const current = await readMcpGrantTokens(server.name, server.url);
          if (current?.refreshToken !== undefined && current.refreshToken !== posted) return tokenResponse(current);
          throw needsAuthSentinel();
        }
        throw err;
      }
    };
    try {
      return await send();
    } catch (err) {
      if (!isConnRefused(err)) throw err;
      try {
        return await send();
      } catch (again) {
        if (isConnRefused(again)) throw connectFailedSentinel();
        throw again;
      }
    }
  };
}

async function refreshHostGrant(server: FrozenHostLoginServer, fetchFn: FetchLike): Promise<void> {
  const rejected = (await readMcpGrantTokens(server.name, server.url))?.accessToken;
  await withMcpGrantLock(server.name, async () => {
    const epoch = readMcpGrantEpoch(server.name);
    const current = await readMcpGrantTokens(server.name, server.url);
    if (current?.refreshToken === undefined) throw new StageMcpGrantError("needs_auth");
    if (rejected !== undefined && current.accessToken !== rejected) return;
    const allowed = await mcpGrantRefreshAllowed(server.name, server.url);
    if (allowed !== "ok") throw new StageMcpGrantError(allowed);
    const bundle = await loadMcpOAuthAdapter();
    const provider = new bundle.McpOAuthProvider(
      server.name,
      server.url,
      {},
      { onRedirect: async () => { throw new StageMcpGrantError("needs_auth"); } },
      { credentialStore: "encrypted-file" },
    );
    try {
      const result = await auth(provider, { serverUrl: server.url, fetchFn });
      if (result !== "AUTHORIZED") throw new StageMcpGrantError("needs_auth");
    } catch (err) {
      if (err instanceof StageMcpGrantError) throw err;
      if (err instanceof OAuthError && err.message.includes(NEEDS_AUTH_SENTINEL)) {
        throw new StageMcpGrantError("needs_auth");
      }
      if (err instanceof OAuthError && err.message.includes(CONNECT_FAILED_SENTINEL)) {
        throw new StageMcpGrantError("connect_failed");
      }
      if (err instanceof UnauthorizedError) throw new StageMcpGrantError("needs_auth");
      throw err;
    } finally {
      provider.deactivate();
      discardMcpGrantIfRevoked(server.name, epoch);
    }
    if ((await readMcpGrantTokens(server.name, server.url))?.refreshToken === undefined) {
      throw new StageMcpGrantError("needs_auth");
    }
  });
}

function findGrantError(error: unknown): StageMcpGrantError | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): StageMcpGrantError | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);
    if (value instanceof StageMcpGrantError) return value;
    if (value instanceof OAuthError && value.message.includes(NEEDS_AUTH_SENTINEL)) {
      return new StageMcpGrantError("needs_auth");
    }
    if (value instanceof OAuthError && value.message.includes(CONNECT_FAILED_SENTINEL)) {
      return new StageMcpGrantError("connect_failed");
    }
    const record = value as { cause?: unknown; errors?: unknown };
    const cause = walk(record.cause);
    if (cause) return cause;
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) {
        const found = walk(item);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(error);
}

function isInsufficientScope(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (value instanceof InsufficientScopeError) return true;
    if (value instanceof SdkHttpError && value.status === 403 && /insufficient_scope/.test(value.message)) return true;
    const record = value as { cause?: unknown; errors?: unknown };
    if (walk(record.cause)) return true;
    if (!Array.isArray(record.errors)) return false;
    return record.errors.some((item) => walk(item));
  };
  return walk(error);
}

function isUnauthorized(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (value instanceof UnauthorizedError) return true;
    if (value instanceof SdkHttpError && value.status === 401) return true;
    const record = value as { cause?: unknown; errors?: unknown };
    if (walk(record.cause)) return true;
    if (!Array.isArray(record.errors)) return false;
    return record.errors.some((item) => walk(item));
  };
  return walk(error);
}

function failureFrom(error: unknown): { ok: false; code: string; message: string } {
  const grant = findGrantError(error);
  if (grant) return failed(grant.grantCode, grant.grantCode);
  if (isInsufficientScope(error)) return failed("insufficient_scope", "insufficient_scope");
  if (isUnauthorized(error)) return failed("needs_auth", "needs_auth");
  if (isMcpConnectFailure(error) || (error instanceof SdkHttpError && error.status === 403)) {
    return failed("connect_failed", "connect_failed");
  }
  return failed("connect_failed", "connect_failed");
}

export function refusalForStoredGrant(
  status: "authenticated" | "expired" | "not_authenticated" | "unavailable",
): { ok: false; code: string; message: string } | undefined {
  if (status === "unavailable") return failed("connect_failed", "connect_failed");
  if (status === "not_authenticated") return failed("needs_auth", "needs_auth");
  return undefined;
}

async function requireStoredGrant(name: string): Promise<{ ok: false; code: string; message: string } | undefined> {
  return refusalForStoredGrant(await mcpStoredGrantStatus(name));
}

async function withHostClient<T>(
  server: FrozenHostLoginServer,
  signal: AbortSignal,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const fetchFn = createGrantFetch(server);
  const client = new Client({ name: "stageflow", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    authProvider: {
      token: async () => (await readMcpGrantTokens(server.name, server.url))?.accessToken,
      onUnauthorized: async () => {
        await refreshHostGrant(server, fetchFn);
      },
    },
    fetch: fetchFn,
    onInsufficientScope: "throw",
  });
  try {
    await client.connect(transport, { signal });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function hostLoginList(
  server: FrozenHostLoginServer,
  signal: AbortSignal,
): Promise<{ ok: true; tools: StageMcpUpstreamTool[] } | { ok: false; code: string; message: string }> {
  if (signal.aborted) return cancelled();
  const blocked = await requireStoredGrant(server.name);
  if (blocked) return blocked;
  try {
    return await withHostClient(server, signal, async (client) => {
      const listed = await client.listTools(undefined, { signal });
      return {
        ok: true as const,
        tools: (listed.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
        })),
      };
    });
  } catch (err) {
    if (signal.aborted) return cancelled();
    return failureFrom(err);
  }
}

async function hostLoginCall(
  server: FrozenHostLoginServer,
  tool: string,
  args: unknown,
  signal: AbortSignal,
): Promise<StageMcpCallView> {
  if (signal.aborted) return cancelled();
  const blocked = await requireStoredGrant(server.name);
  if (blocked) return blocked;
  try {
    return await withHostClient(server, signal, async (client) => {
      const result = await client.callTool(
        { name: tool, arguments: args !== null && typeof args === "object" ? args as Record<string, unknown> : {} },
        { signal },
      );
      const text = Array.isArray(result.content)
        ? result.content
          .filter((block): block is { type: "text"; text: string } => (
            typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
          ))
          .map((block) => block.text)
          .join("\n")
        : "";
      return { ok: true as const, text };
    });
  } catch (err) {
    if (signal.aborted) return cancelled();
    return failureFrom(err);
  }
}

const realUpstream: StageMcpUpstream = {
  list: hostLoginList,
  call: hostLoginCall,
};

let upstream: StageMcpUpstream = realUpstream;

export function setStageMcpUpstreamForTests(next: StageMcpUpstream | undefined): void {
  upstream = next ?? realUpstream;
}

export function stageMcpSessionToolName(server: string, tool: string): string {
  return formatToolName(tool, server, "server");
}

function wildcard(names: readonly string[] | undefined): boolean {
  return names !== undefined && names.length === 1 && names[0] === "*";
}

/** A present `mcp_tools` entry that is not `["*"]` is a named allowlist. */
export function stageMcpAllowlistRestricts(stage: { mcp_tools?: StageMcpTools } | undefined): boolean {
  const tools = stage?.mcp_tools;
  if (tools === undefined) return false;
  return Object.values(tools).some((names) => !wildcard(names));
}

export function filterStageWorkerMcpToolNames(
  stage: { mcp?: readonly string[]; mcp_tools?: StageMcpTools } | undefined,
  workerServers: readonly string[],
  names: readonly string[],
): string[] {
  if (!stageMcpAllowlistRestricts(stage)) return [...names];
  const allowed = new Set<string>();
  for (const server of workerServers) {
    if (!stage?.mcp?.includes(server)) continue;
    const named = stage.mcp_tools?.[server];
    if (named === undefined) continue;
    if (wildcard(named)) {
      const sample = stageMcpSessionToolName(server, "zzsentinel");
      const head = sample.endsWith("_zzsentinel") ? sample.slice(0, -"_zzsentinel".length) : sample;
      for (const name of names) {
        if (name.startsWith(`${head}_`)) allowed.add(name);
      }
    } else {
      for (const tool of named) allowed.add(stageMcpSessionToolName(server, tool));
    }
  }
  return names.filter((name) => allowed.has(name));
}

export function stageMcpToolPermitted(
  stage: StageMcpAllowlistStage | undefined,
  server: string,
  tool: string,
): boolean {
  if (!stage?.mcp?.includes(server)) return false;
  if (stage.mcp_tools === undefined) return true;
  const named = stage.mcp_tools[server];
  if (named === undefined) return false;
  if (wildcard(named)) return true;
  return named.includes(tool);
}

function missingNamedTool(
  stage: StageMcpAllowlistStage,
  server: string,
  tools: readonly { name: string }[],
): boolean {
  const named = stage.mcp_tools?.[server];
  if (named === undefined || wildcard(named)) return false;
  const live = new Set(tools.map((tool) => tool.name));
  return named.some((name) => name !== "*" && !live.has(name));
}

async function grantSecrets(server: FrozenHostLoginServer): Promise<string[]> {
  try {
    return await mcpGrantSecretValues(server.name, server.url);
  } catch {
    const key = (process.env[OAUTH_FILE_KEY_ENV] ?? "").trim();
    return key.length >= 8 ? [key] : [];
  }
}

function stripText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("");
  }
  return out;
}

function stripValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return stripText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => stripValue(item, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = stripValue(item, secrets);
    return out;
  }
  return value;
}

function denied(): { ok: false; code: string; message: string } {
  return { ok: false, code: "permission_denied", message: "permission_denied" };
}

function cancelled(): { ok: false; code: string; message: string } {
  return { ok: false, code: "cancelled", message: "cancelled" };
}

function failed(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/**
 * Host-login names for the stage this process forked. The child writes
 * `freezeHostLoginServers` in its own process; that map is not the authority here.
 */
export async function classifyParentHostLogin(input: {
  stage?: StageMcpAllowlistStage;
  bindingKind?: DerivedBindingKind;
  factoryCwd?: string;
  rootDir: string;
  env?: Record<string, string>;
}): Promise<readonly FrozenHostLoginServer[]> {
  const names = input.stage?.mcp ?? [];
  if (names.length === 0) return [];
  const repository = input.bindingKind === "repository";
  const resolution = await resolveStageMcpServersDetailed({
    projectRoot: input.factoryCwd ?? input.rootDir,
    allowlist: [...names],
    env: input.env ?? {},
    bindingKind: repository ? "repository" : input.bindingKind === "checkout" ? "checkout" : "none",
    ...(repository
      ? {}
      : { scope: { kind: "stage" as const, secrets: (input.stage?.secrets ?? []).map((secret) => secret.name) } }),
  });
  return partitionHostLogin(resolution, {
    bindingKind: repository ? "repository" : input.bindingKind === "checkout" ? "checkout" : "none",
  }).hostLogin;
}

export async function serveStageMcpList(input: {
  frozen: readonly FrozenHostLoginServer[];
  stage: StageMcpAllowlistStage;
  signal: AbortSignal;
}): Promise<StageMcpListView> {
  if (input.signal.aborted) return cancelled();
  const tools: StageMcpListedTool[] = [];
  let opened = false;
  for (const server of input.frozen) {
    if (!input.stage.mcp?.includes(server.name)) continue;
    if (input.signal.aborted) return cancelled();
    if (!opened) {
      prepareMcpOAuth();
      opened = true;
    }
    let listed: Awaited<ReturnType<StageMcpUpstream["list"]>>;
    try {
      listed = await upstream.list(server, input.signal);
    } catch {
      if (input.signal.aborted) return cancelled();
      return failed("connect_failed", "connect_failed");
    }
    if (!listed.ok) return failed(listed.code, listed.message);
    if (missingNamedTool(input.stage, server.name, listed.tools)) {
      return failed("mcp_tool_missing", "mcp_tool_missing");
    }
    const secrets = await grantSecrets(server);
    for (const tool of listed.tools) {
      if (!stageMcpToolPermitted(input.stage, server.name, tool.name)) continue;
      const description = tool.description !== undefined ? stripText(tool.description, secrets) : undefined;
      tools.push({
        server: server.name,
        name: stripText(tool.name, secrets),
        ...(description !== undefined ? { description } : {}),
        ...(tool.inputSchema !== undefined
          ? { inputSchema: stripValue(tool.inputSchema, secrets) as Record<string, unknown> }
          : {}),
      });
    }
  }
  return { ok: true, tools };
}

export async function serveStageMcpCall(input: {
  frozen: readonly FrozenHostLoginServer[];
  stage: StageMcpAllowlistStage;
  server: string;
  tool: string;
  arguments: unknown;
  signal: AbortSignal;
}): Promise<StageMcpCallView> {
  if (input.signal.aborted) return cancelled();
  const server = input.frozen.find((item) => item.name === input.server);
  if (!server || !stageMcpToolPermitted(input.stage, input.server, input.tool)) return denied();
  prepareMcpOAuth();
  if (input.signal.aborted) return cancelled();
  const secrets = [...await grantSecrets(server)];
  try {
    const result = await upstream.call(server, input.tool, input.arguments, input.signal);
    if (result.ok) {
      secrets.push(...await grantSecrets(server));
      return { ok: true, text: stripText(result.text, secrets) };
    }
    return failed(result.code, result.message);
  } catch {
    if (input.signal.aborted) return cancelled();
    return failed("connect_failed", "connect_failed");
  }
}
