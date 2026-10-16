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
  removeMcpOAuth,
  resetMcpOAuthFlowCacheForTests,
  startMcpOAuth,
  McpOAuthError,
  OAUTH_FILE_KEY_ENV,
} from "../src/config/mcpOAuth.js";
import { listCachedMcpTools } from "../src/config/mcpToolCache.js";
import { probeProjectMcpServer } from "../src/agent/piIsolatedMcpProbe.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
let root: string;
let agentDir: string;
let auth: Server;
let base: string;
const saved: Record<string, string | undefined> = {};

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
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
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
      req.resume();
      req.on("end", () => json(200, { access_token: "at-123", refresh_token: "rt-456", token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (url.pathname === "/mcp" && req.headers.authorization === "Bearer at-123") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (msg.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          msg.method === "initialize"
            ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
            : msg.method === "tools/list"
              ? { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] }
              : {};
        json(200, { jsonrpc: "2.0", id: msg.id, result });
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
  await startFakeOAuthServer();
});

afterEach(async () => {
  await new Promise<void>((resolve) => auth.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
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
