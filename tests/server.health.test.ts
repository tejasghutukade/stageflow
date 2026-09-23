import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import {
  resetReadyzCacheForTests,
} from "../src/diagnostics/checks.js";

const temps: string[] = [];
const READ = "r".repeat(32);

afterEach(() => {
  resetReadyzCacheForTests();
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("health surfaces", () => {
  it("GET /livez returns 200 JSON with store unusable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-livez-"));
    temps.push(root);
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
      await store.close();
      const t0 = Date.now();
      const res = await fetch(`${started.url}/livez`);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "live" });
      expect(elapsed).toBeLessThan(100);
    } finally {
      await closeServer(started.server);
    }
  });

  it("GET /readyz returns 200 when ready and caches git spawn", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-readyz-"));
    temps.push(root);
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
      const a = await fetch(`${started.url}/readyz`);
      const b = await fetch(`${started.url}/readyz`);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const body = await b.json();
      expect(body.ready).toBe(true);
      expect(body.checks.git_present).toBe(true);
    } finally {
      await closeServer(started.server);
    }
  });

  it("GET /api/health requires read scope when tokens configured", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-health-auth-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: "d".repeat(32),
        STAGEFLOW_READ_TOKEN: READ,
      }),
    });
    try {
      const denied = await fetch(`${started.url}/api/health`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`${started.url}/api/health`, {
        headers: { Authorization: `Bearer ${READ}` },
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(body.version).toBeTruthy();
      expect(body.maxConcurrent).toBeTruthy();
      expect(body.capacity).toBeTruthy();
      expect(Array.isArray(body.catalog_roots)).toBe(true);
      const roots = body.catalog_roots as Array<Record<string, unknown>>;
      expect(roots.length).toBeGreaterThan(0);
      for (const r of roots) {
        expect(r).toEqual(
          expect.objectContaining({
            project_root: expect.any(String),
            kind: expect.stringMatching(/^(boot|registered|seeded)$/),
            read_only: expect.any(Boolean),
          }),
        );
        expect(r).not.toHaveProperty("path");
      }
    } finally {
      await closeServer(started.server);
    }
  });
});
