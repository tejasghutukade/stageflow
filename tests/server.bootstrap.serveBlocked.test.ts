import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { ensureGlobalHome, globalStageflowHome } from "../src/project/globalHome.js";
import * as createStore from "../src/runstore/createStore.js";
import { restoreFailedPath } from "../src/runstore/restore.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const READ = "r".repeat(32);

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("bootstrap serveBlocked", () => {
  it("skips store open and RunManager when restore.failed is present", async () => {
    await withIsolatedHome(async () => {
      ensureGlobalHome();
      const home = globalStageflowHome();
      writeFileSync(
        restoreFailedPath(home),
        JSON.stringify({ reason: "injected restore.failed" }),
        "utf8",
      );
      const spy = vi.spyOn(createStore, "createRunStoreWithConnection");
      try {
        const boot = await bootstrapStageflowHost({
          agent: scriptedFakeAgent([]),
          skipHostConfig: true,
          cwd: home,
        });
        expect(boot.serveBlocked).toEqual({
          code: "restore_failed",
          reason: expect.stringMatching(/restore\.failed/),
        });
        expect(spy).not.toHaveBeenCalled();
        expect(boot.store).toBeUndefined();
        expect(boot.manager).toBeUndefined();
        expect(boot.a2a).toBeUndefined();
        expect(boot.gcInterval).toBeUndefined();
        boot.stopGcInterval();
        await boot.mcpHandler.close();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("serves livez, fails readyz, and 503s A2A when serveBlocked", async () => {
    await withIsolatedHome(async () => {
      ensureGlobalHome();
      const home = globalStageflowHome();
      mkdirSync(path.join(home, "agent"), { recursive: true });
      writeFileSync(
        restoreFailedPath(home),
        JSON.stringify({ reason: "injected restore.failed" }),
        "utf8",
      );
      const tokens = loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: "d".repeat(32),
        STAGEFLOW_READ_TOKEN: READ,
      });
      const started = await startMcpServer({
        agent: scriptedFakeAgent([]),
        cwd: home,
        rootDir: home,
        port: 0,
        mcpStateless: true,
        controlTokens: tokens,
      });
      try {
        expect(started.store).toBeUndefined();
        expect(started.manager).toBeUndefined();

        const live = await fetch(`${started.url}/livez`);
        expect(live.status).toBe(200);

        const ready = await fetch(`${started.url}/readyz`);
        expect(ready.status).toBe(503);
        const readyBody = (await ready.json()) as {
          code?: string;
          ready?: boolean;
        };
        expect(readyBody.ready).toBe(false);
        expect(readyBody.code).toBe("restore_failed");

        const a2aStatus = await fetch(`${started.url}/api/a2a/status`, {
          headers: { Authorization: `Bearer ${READ}` },
        });
        expect(a2aStatus.status).toBe(503);
        const a2aStatusBody = (await a2aStatus.json()) as {
          code?: string;
          error?: string;
        };
        expect(a2aStatusBody.code).toBe("restore_failed");
        expect(a2aStatusBody.error).toMatch(/restore\.failed/);

        const a2a = await fetch(`${started.url}/a2a`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(a2a.status).toBe(503);
        const a2aBody = (await a2a.json()) as { code?: string };
        expect(a2aBody.code).toBe("restore_failed");

        const mcp = await fetch(`${started.url}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"d".repeat(32)}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "t", version: "0" },
            },
          }),
        });
        expect(mcp.status).toBe(503);
      } finally {
        await closeServer(started.server);
      }
    });
  });
});
