import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completeMcpOAuth,
  mcpOAuthStatus,
  oauthKeyPath,
  prepareMcpOAuth,
  readMcpGrantTokens,
  removeMcpOAuth,
  resetMcpGrantLocksForTests,
  resetMcpOAuthFlowCacheForTests,
  startMcpOAuth,
  McpOAuthError,
  OAUTH_FILE_KEY_ENV,
} from "../src/config/mcpOAuth.js";
import { freezeHostLoginServers, hostLoginAttemptKey, resetFrozenHostLoginServersForTests } from "../src/config/hostLoginMcp.js";
import { setStageMcpUpstreamForTests } from "../src/runtime/stageMcpHost.js";
import { listStageMcpTools } from "../src/runtime/stageMcpWorker.js";
import { inspectMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
import { listCachedMcpTools } from "../src/config/mcpToolCache.js";
import { probeProjectMcpServer } from "../src/agent/piIsolatedMcpProbe.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
let root: string;
let agentDir: string;
let auth: Server;
let base: string;
const saved: Record<string, string | undefined> = {};

const grantBehavior = {
  list401UntilRefresh: false,
  refreshDelayMs: 0,
  tokenEndpoint: "",
  refreshMode: "ok" as "ok" | "timeout" | "refuse-once",
  refreshPosts: 0,
  listPosts: 0,
  authorizeHits: 0,
  mcpPosts: 0,
  toolText: "ping",
  refusedRefresh: false,
  lastRefreshToken: "",
  rejectAccess: "",
};

/** A tiny OAuth 2.1 authorization server + protected MCP endpoint (dynamic client registration, PKCE). */
async function startFakeOAuthServer(): Promise<void> {
  auth = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: grantBehavior.tokenEndpoint || `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/authorize") {
      grantBehavior.authorizeHits += 1;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        json(201, { ...body, client_id: "fake-client", token_endpoint_auth_method: "none" });
      });
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (body.includes("grant_type=refresh_token")) {
          grantBehavior.refreshPosts += 1;
          grantBehavior.lastRefreshToken = new URLSearchParams(body).get("refresh_token") ?? "";
          if (grantBehavior.refreshMode === "timeout") return;
          if (grantBehavior.refreshMode === "refuse-once" && !grantBehavior.refusedRefresh) {
            grantBehavior.refusedRefresh = true;
            res.destroy();
            return;
          }
          const finish = () => json(200, {
            access_token: `at-refresh-${grantBehavior.refreshPosts}`,
            refresh_token: `rt-refresh-${grantBehavior.refreshPosts}`,
            token_type: "Bearer",
            expires_in: 3600,
          });
          if (grantBehavior.refreshDelayMs > 0) setTimeout(finish, grantBehavior.refreshDelayMs);
          else finish();
          return;
        }
        json(200, { access_token: "at-123", refresh_token: "rt-456", token_type: "Bearer", expires_in: 3600 });
      });
      return;
    }
    if (url.pathname === "/mcp" && req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      grantBehavior.mcpPosts += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const bearer = req.headers.authorization;
        const refreshed = typeof bearer === "string" && bearer.startsWith("Bearer at-refresh-");
        if (msg.method === "tools/list") grantBehavior.listPosts += 1;
        if (msg.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        if (msg.method === "tools/list" && grantBehavior.rejectAccess !== "" && bearer === `Bearer ${grantBehavior.rejectAccess}`) {
          return json(401, { error: "invalid_token" }, {
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        if (grantBehavior.list401UntilRefresh && msg.method === "tools/list" && !refreshed) {
          return json(401, { error: "invalid_token" }, {
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        if (bearer === "Bearer at-123" || refreshed) {
          const result =
            msg.method === "initialize"
              ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
              : msg.method === "tools/list"
                ? { tools: [{ name: "ping", description: grantBehavior.toolText, inputSchema: { type: "object", properties: {} } }] }
                : msg.method === "tools/call"
                  ? { content: [{ type: "text", text: grantBehavior.toolText }] }
                  : {};
          return json(200, { jsonrpc: "2.0", id: msg.id, result });
        }
        return json(401, { error: "unauthorized" }, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
      });
      return;
    }
    if (url.pathname === "/mcp") {
      return json(401, { error: "unauthorized" }, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => auth.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  for (const key of ["STAGEFLOW_HOME", "PI_CODING_AGENT_DIR", OAUTH_FILE_KEY_ENV]) saved[key] = process.env[key];
  home = await mkdtemp(path.join(tmpdir(), "sf-oauth-home-"));
  root = await mkdtemp(path.join(tmpdir(), "sf-oauth-root-"));
  agentDir = path.join(await mkdtemp(path.join(tmpdir(), "sf-oauth-agent-")), "agent");
  process.env.STAGEFLOW_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[OAUTH_FILE_KEY_ENV];
  resetGlobalStageflowHomeForTests();
  resetMcpOAuthFlowCacheForTests();
  resetMcpGrantLocksForTests();
  resetFrozenHostLoginServersForTests();
  setStageMcpUpstreamForTests(undefined);
  grantBehavior.list401UntilRefresh = false;
  grantBehavior.refreshDelayMs = 0;
  grantBehavior.tokenEndpoint = "";
  grantBehavior.refreshMode = "ok";
  grantBehavior.refreshPosts = 0;
  grantBehavior.listPosts = 0;
  grantBehavior.authorizeHits = 0;
  grantBehavior.mcpPosts = 0;
  grantBehavior.toolText = "ping";
  grantBehavior.refusedRefresh = false;
  grantBehavior.lastRefreshToken = "";
  grantBehavior.rejectAccess = "";
  await startFakeOAuthServer();
});

afterEach(async () => {
  await new Promise<void>((resolve) => auth.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
  resetMcpGrantLocksForTests();
  resetFrozenHostLoginServersForTests();
  setStageMcpUpstreamForTests(undefined);
});

describe("prepareMcpOAuth", () => {
  it("creates one private key and reuses it", async () => {
    prepareMcpOAuth();
    const key = (await readFile(oauthKeyPath(home), "utf8")).trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(process.env[OAUTH_FILE_KEY_ENV]).toBe(key);
    expect((await stat(oauthKeyPath(home))).mode & 0o777).toBe(0o600);

    delete process.env[OAUTH_FILE_KEY_ENV];
    prepareMcpOAuth();
    expect(process.env[OAUTH_FILE_KEY_ENV]).toBe(key);
  });

  it("keeps an operator-supplied key", () => {
    process.env[OAUTH_FILE_KEY_ENV] = Buffer.alloc(32, 7).toString("base64");
    prepareMcpOAuth();
    expect(existsSync(oauthKeyPath(home))).toBe(false);
  });
});

describe("MCP OAuth sign-in", () => {
  it("signs in with a pasted redirect URL and signs out", async () => {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: `${base}/mcp` } } }));

    expect(await mcpOAuthStatus("remote")).toBe("not_authenticated");
    const { authorizationUrl } = await startMcpOAuth(root, "remote");
    const authz = new URL(authorizationUrl);
    expect(authz.origin).toBe(base);
    expect(authz.pathname).toBe("/authorize");
    expect(authz.searchParams.get("code_challenge_method")).toBe("S256");

    // the user's browser lands on the (unreachable) callback; they paste that address back
    const redirect = new URL(authz.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "auth-code");
    redirect.searchParams.set("state", authz.searchParams.get("state")!);

    await expect(completeMcpOAuth("remote", `${redirect.origin}${redirect.pathname}?code=x&state=WRONG`)).rejects.toThrow(/state/i);
    expect(await completeMcpOAuth("remote", redirect.toString())).toBe("authenticated");
    expect(await mcpOAuthStatus("remote")).toBe("authenticated");

    // tokens are on disk only inside the Host store, encrypted
    const store = path.join(agentDir, "mcp-oauth-encrypted");
    const entries = await readdir(store);
    expect(entries).toHaveLength(1);
    const blob = await readFile(path.join(store, entries[0]!, "credentials.json"), "utf8");
    expect(blob).not.toContain("at-123");
    expect(blob).not.toContain("rt-456");

    await removeMcpOAuth("remote");
    expect(await mcpOAuthStatus("remote")).toBe("not_authenticated");
  });

  it("lets the adapter connect with the stored token (Check goes from needs_auth to connected)", async () => {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: `${base}/mcp` } } }));
    const before = await probeProjectMcpServer({ projectRoot: root, name: "remote", timeoutMs: 8000 });
    expect(before.status).toBe("needs_auth");

    const { authorizationUrl } = await startMcpOAuth(root, "remote");
    const authz = new URL(authorizationUrl);
    const redirect = new URL(authz.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "auth-code");
    redirect.searchParams.set("state", authz.searchParams.get("state")!);
    await completeMcpOAuth("remote", redirect.toString());

    const after = await probeProjectMcpServer({ projectRoot: root, name: "remote", timeoutMs: 8000 });
    expect(after).toEqual({ name: "remote", status: "connected", tools: [{ name: "ping", description: "ping" }] });
    expect(listCachedMcpTools("remote")?.tools).toEqual([{ name: "ping", description: "ping" }]);
  }, 30_000);

  it("rejects unknown and local-command servers", async () => {
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "npx" } } }));
    await expect(startMcpOAuth(root, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(startMcpOAuth(root, "local")).rejects.toMatchObject({ code: "not_http" });
    expect(McpOAuthError).toBeDefined();
  });
});

async function signInRemote(): Promise<void> {
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: `${base}/mcp` } } }));
  const { authorizationUrl } = await startMcpOAuth(root, "remote");
  const authz = new URL(authorizationUrl);
  const redirect = new URL(authz.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "auth-code");
  redirect.searchParams.set("state", authz.searchParams.get("state")!);
  expect(await completeMcpOAuth("remote", redirect.toString(), root)).toBe("authenticated");
}

function freezeRemote(): void {
  freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-oauth", stageId: "inventory", attempt: 1 }), [
    { name: "remote", url: `${base}/mcp` },
  ]);
}

function listRemote() {
  return listStageMcpTools({
    runId: "run-oauth",
    stageId: "inventory",
    attempt: 1,
    stage: { mcp: ["remote"] },
  });
}

describe("stage grant refresh", () => {
  it("refreshes once when a 401 arrives before expiresAt and retries the list", async () => {
    await signInRemote();
    const tokens = await readMcpGrantTokens("remote", `${base}/mcp`);
    expect(tokens?.expiresAt).toBeGreaterThan(Date.now() / 1000);
    grantBehavior.list401UntilRefresh = true;
    freezeRemote();
    await expect(listRemote()).resolves.toMatchObject({
      ok: true,
      tools: [expect.objectContaining({ name: "ping" })],
    });
    expect(grantBehavior.refreshPosts).toBe(1);
    expect(grantBehavior.listPosts).toBe(2);
  }, 20_000);

  it("sends one token request when two refreshes overlap and keeps the new refresh token", async () => {
    await signInRemote();
    grantBehavior.list401UntilRefresh = true;
    grantBehavior.refreshDelayMs = 250;
    freezeRemote();
    const [first, second] = await Promise.all([listRemote(), listRemote()]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(grantBehavior.refreshPosts).toBe(1);
    expect(inspectMcpOAuthTokensForUrl("remote", `${base}/mcp`, { credentialStore: "encrypted-file" })).toMatchObject({
      status: "present",
      tokens: { refreshToken: "rt-refresh-1" },
    });
  }, 20_000);

  it("does not authorize or refresh on the next list after sign-out", async () => {
    await signInRemote();
    expect((await readMcpGrantTokens("remote", `${base}/mcp`))?.accessToken).toBe("at-123");
    await removeMcpOAuth("remote", root);
    const mcpPosts = grantBehavior.mcpPosts;
    freezeRemote();
    await expect(listRemote()).resolves.toMatchObject({ ok: false, code: "needs_auth" });
    expect(grantBehavior.mcpPosts).toBe(mcpPosts);
    expect(grantBehavior.refreshPosts).toBe(0);
    expect(grantBehavior.listPosts).toBe(0);
    expect(grantBehavior.authorizeHits).toBe(0);
    const store = path.join(agentDir, "mcp-oauth-encrypted");
    const entries = existsSync(store) ? await readdir(store) : [];
    for (const entry of entries) {
      expect(existsSync(path.join(store, entry, "credentials.json"))).toBe(false);
    }
  }, 20_000);

  it("refreshes with the refresh token now in the file", async () => {
    await signInRemote();
    const stale = (await readMcpGrantTokens("remote", `${base}/mcp`))?.refreshToken;
    expect(stale).toBe("rt-456");
    grantBehavior.list401UntilRefresh = true;
    freezeRemote();
    await listRemote();
    const rotated = await readMcpGrantTokens("remote", `${base}/mcp`);
    expect(rotated?.refreshToken).toBe("rt-refresh-1");
    grantBehavior.list401UntilRefresh = false;
    grantBehavior.rejectAccess = rotated?.accessToken ?? "";
    await listRemote();
    expect(grantBehavior.lastRefreshToken).toBe(rotated?.refreshToken);
    expect(grantBehavior.lastRefreshToken).not.toBe(stale);
  }, 20_000);

  it("does not post a refresh token when discovery names a different token endpoint", async () => {
    await signInRemote();
    const before = (await readMcpGrantTokens("remote", `${base}/mcp`))?.refreshToken;
    grantBehavior.tokenEndpoint = `${base}/token-moved`;
    grantBehavior.list401UntilRefresh = true;
    freezeRemote();
    await expect(listRemote()).resolves.toMatchObject({ ok: false, code: "needs_auth" });
    expect(grantBehavior.refreshPosts).toBe(0);
    expect(grantBehavior.authorizeHits).toBe(0);
    expect((await readMcpGrantTokens("remote", `${base}/mcp`))?.refreshToken).toBe(before);
  }, 20_000);

  it("does not send a refresh token again after the token request times out", async () => {
    await signInRemote();
    grantBehavior.list401UntilRefresh = true;
    freezeRemote();
    const realFetch = globalThis.fetch;
    let refreshFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === "string"
          ? init.body
          : "";
      if (url.endsWith("/token") && body.includes("grant_type=refresh_token")) {
        refreshFetches += 1;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(listRemote()).resolves.toMatchObject({ ok: false, code: "needs_auth" });
      expect(refreshFetches).toBe(1);
      expect((await readMcpGrantTokens("remote", `${base}/mcp`))?.refreshToken).toBe("rt-456");
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 20_000);

  it("retries a refused token connection once", async () => {
    await signInRemote();
    grantBehavior.list401UntilRefresh = true;
    freezeRemote();
    const realFetch = globalThis.fetch;
    let refreshFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === "string"
          ? init.body
          : "";
      if (url.endsWith("/token") && body.includes("grant_type=refresh_token")) {
        refreshFetches += 1;
        if (refreshFetches === 1) {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(listRemote()).resolves.toMatchObject({ ok: true });
      expect(refreshFetches).toBe(2);
      expect(grantBehavior.refreshPosts).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 20_000);
});
