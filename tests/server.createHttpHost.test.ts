import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { startMcpServer } from "../src/server/mcpHost.js";

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("createHttpHost shared listen", () => {
  it("startMcpServer sets requestTimeout 0 and returns envelope fields", async () => {
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
      expect(started.server.requestTimeout).toBe(0);
      expect(started.mcpUrl).toBe(`${started.url}/mcp`);
      expect(started.manager).toBeTruthy();
      expect(started.store).toBeTruthy();
      expect(typeof started.store.readRun).toBe("function");
      expect(started.runChangeBus).toBeTruthy();
      expect(started.mcpStateless).toBe(true);
      expect(started.host).toBe("127.0.0.1");
      expect(started.port).toBeGreaterThan(0);
    } finally {
      await closeServer(started.server);
    }
  });

  it("startUiServer sets requestTimeout 0 and returns envelope fields", async () => {
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
      expect(started.server.requestTimeout).toBe(0);
      expect(started.mcpUrl).toBe(`${started.url}/mcp`);
      expect(started.manager).toBeTruthy();
      expect(started.store).toBeTruthy();
      expect(started.runChangeBus).toBeTruthy();
      expect(started.mcpStateless).toBe(true);
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
});
