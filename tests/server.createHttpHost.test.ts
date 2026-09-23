import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { resolveAllowedHosts } from "../src/server/allowedHosts.js";
import {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/server/createHttpHost.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("createHttpHost shared listen", () => {
  it("startMcpServer sets finite requestTimeout and returns envelope fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-mcp-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
    });
    try {
      expect(started.server.requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(started.server.maxConnections).toBe(DEFAULT_MAX_CONNECTIONS);
      expect(started.mcpUrl).toBe(`${started.url}/mcp`);
      expect(started.manager).toBeTruthy();
      expect(started.store).toBeTruthy();
      expect(typeof started.store!.readRun).toBe("function");
      expect(started.runChangeBus).toBeTruthy();
      expect(started.mcpStateless).toBe(true);
      expect(started.host).toBe("127.0.0.1");
      expect(started.port).toBeGreaterThan(0);
    } finally {
      await closeServer(started.server);
    }
  });

  it("startUiServer sets finite requestTimeout and returns envelope fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-ui-"));
    const store = createRunStore({ rootDir: root });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });
    try {
      expect(started.server.requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(started.mcpUrl).toBe(`${started.url}/mcp`);
      expect(started.manager).toBeTruthy();
      expect(started.store).toBeTruthy();
      expect(started.runChangeBus).toBeTruthy();
      expect(started.mcpStateless).toBe(true);
    } finally {
      await closeServer(started.server);
    }
  });

  it("advertises loopback for 0.0.0.0 bind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-adv-"));
    const store = createRunStore({ rootDir: root });
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      host: "0.0.0.0",
      mcpStateless: true,
      controlTokens: tokens,
    });
    try {
      expect(started.host).toBe("0.0.0.0");
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await closeServer(started.server);
    }
  });

  it("startMcpServer returns 404 JSON for unknown paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-404-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
    });
    try {
      const res = await fetch(`${url}/no-such-route`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    } finally {
      await closeServer(server);
    }
  });

  it("startMcpServer rejects evil Origin on /mcp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-origin-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
    });
    try {
      const forbidden = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it("loopback without token leaves GET /api/runs ungated by bearer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-notoken-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: loadControlTokens({}),
    });
    try {
      const res = await fetch(`${url}/api/runs`);
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("enforces bearer scopes when tokens are configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-token-"));
    const store = createRunStore({ rootDir: root });
    const tokens = loadControlTokens({
      STAGEFLOW_CONTROL_TOKEN: DRIVE,
      STAGEFLOW_READ_TOKEN: READ,
    });
    const { server, url } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: tokens,
    });
    try {
      const noAuth = await fetch(`${url}/api/runs`);
      expect(noAuth.status).toBe(401);
      expect(noAuth.headers.get("www-authenticate")).toMatch(/Bearer/i);

      const readOk = await fetch(`${url}/api/runs`, {
        headers: { Authorization: `Bearer ${READ}` },
      });
      expect(readOk.status).toBe(200);

      const readPost = await fetch(`${url}/api/runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ task: "x", pipeline: "y" }),
      });
      expect(readPost.status).toBe(403);

      const livez = await fetch(`${url}/livez`);
      expect(livez.status).toBe(200);

      const healthDenied = await fetch(`${url}/api/health`);
      expect(healthDenied.status).toBe(401);

      const health = await fetch(`${url}/api/health`, {
        headers: { Authorization: `Bearer ${READ}` },
      });
      expect(health.status).toBe(200);

      const mcpRead = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(mcpRead.status).toBe(403);

      const driveGet = await fetch(`${url}/api/runs`, {
        headers: { Authorization: `Bearer ${DRIVE}` },
      });
      expect(driveGet.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects disallowed Host before bearer check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-hostgate-"));
    const store = createRunStore({ rootDir: root });
    const tokens = loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE });
    const allowedHosts = resolveAllowedHosts({
      STAGEFLOW_ALLOWED_HOSTS: "build-box:3847",
    });
    const { server, port } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: tokens,
      allowedHosts,
    });
    try {
      const { request } = await import("node:http");
      const body = await new Promise<{ status: number; json: { error?: string } }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/runs",
              method: "GET",
              headers: {
                Host: "evil.example",
                Authorization: `Bearer ${DRIVE}`,
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({
                  status: res.statusCode ?? 0,
                  json: JSON.parse(text) as { error?: string },
                });
              });
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(body.status).toBe(403);
      expect(body.json.error).toBe("Forbidden host");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps idle socket timeout at 0 so MCP can outlive requestTimeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-sse-"));
    const store = createRunStore({ rootDir: root });
    const { server, url } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      requestTimeoutMs: 50,
    });
    try {
      expect(server.requestTimeout).toBe(50);
      expect(server.timeout).toBe(0);
      const health = await fetch(`${url}/api/health`);
      expect(health.status).toBe(200);
      await new Promise((r) => setTimeout(r, 80));
      const health2 = await fetch(`${url}/api/health`);
      expect(health2.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("serves requests when bound to IPv6 loopback without throwing on URL parse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-ipv6-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      host: "::1",
      mcpStateless: true,
    });
    try {
      expect(started.host).toBe("::1");
      expect(started.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      const health = await fetch(`${started.url}/api/health`);
      expect(health.status).toBe(200);
      const runs = await fetch(`${started.url}/api/runs`);
      expect(runs.status).toBe(200);
    } finally {
      await closeServer(started.server);
    }
  });

  it("runtime server error after listen does not throw uncaught", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-http-host-err-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
    });
    try {
      expect(() => {
        started.server.emit("error", new Error("simulated"));
      }).not.toThrow();
    } finally {
      await closeServer(started.server);
    }
  });
});
