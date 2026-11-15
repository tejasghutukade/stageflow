import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { createArchiveSlot } from "../src/server/archiveRoutes.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);
const CANARY = "CANARY-SECRET-5b21";

async function closeServer(server: { close: (cb: (err?: Error | null) => void) => void }): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe("archive HTTP routes", () => {
  it("POST builds an archive without secrets and without a path, drive GET streams it, read tokens and bad names are refused", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      mkdirSync(path.join(home, "agent"), { recursive: true });
      writeFileSync(path.join(home, "agent", "auth.json"), `{"key":"${CANARY}"}\n`, { mode: 0o600 });
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const started = await startMcpServer({
        agent: scriptedFakeAgent([]), cwd: home, rootDir: home, store, port: 0, mcpStateless: true,
        controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE, STAGEFLOW_READ_TOKEN: READ }),
      });
      const drive = { Authorization: `Bearer ${DRIVE}`, "Content-Type": "application/json" };
      try {
        const readPost = await fetch(`${started.url}/api/archive`, { method: "POST", headers: { Authorization: `Bearer ${READ}`, "Content-Type": "application/json" }, body: "{}" });
        expect(readPost.status).toBe(403);

        const created = await fetch(`${started.url}/api/archive`, { method: "POST", headers: drive, body: "{}" });
        expect(created.status).toBe(200);
        const text = await created.text();
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain(home);
        const meta = JSON.parse(text) as Record<string, unknown>;
        expect(meta).toMatchObject({ contains_secrets: false, archive_version: 1 });
        expect(meta.path).toBeUndefined();
        expect(meta.name).toMatch(/^stageflow-archive-.*\.tar\.gz$/);
        expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);

        const name = String(meta.name);
        const readGet = await fetch(`${started.url}/api/archive/${name}`, { headers: { Authorization: `Bearer ${READ}` } });
        expect(readGet.status).toBe(403);
        const driveGet = await fetch(`${started.url}/api/archive/${name}`, { headers: { Authorization: `Bearer ${DRIVE}` } });
        expect(driveGet.status).toBe(200);
        expect(Buffer.from(await driveGet.arrayBuffer()).length).toBe(meta.bytes);

        for (const bad of ["../../etc/passwd", "x.tar.gz.PARTIAL", "missing.tar.gz"]) {
          const res = await fetch(`${started.url}/api/archive/${encodeURIComponent(bad)}`, { headers: { Authorization: `Bearer ${DRIVE}` } });
          expect(res.status, bad).toBe(400);
        }

        const withSecrets = await fetch(`${started.url}/api/archive`, { method: "POST", headers: drive, body: JSON.stringify({ include_secrets: true }) });
        expect(withSecrets.status).toBe(200);
        const secretText = await withSecrets.text();
        expect(JSON.parse(secretText).contains_secrets).toBe(true);
        expect(secretText).not.toContain(CANARY);

        const badBody = await fetch(`${started.url}/api/archive`, { method: "POST", headers: drive, body: "{not json" });
        expect(badBody.status).toBe(400);
      } finally {
        await closeServer(started.server);
      }
    });
  });

  it("answers 409 while another archive is being built", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const slot = createArchiveSlot();
      const started = await startMcpServer({
        agent: scriptedFakeAgent([]), cwd: home, rootDir: home, store, port: 0, mcpStateless: true,
        controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }), archiveSlot: slot,
      });
      try {
        slot.busy = true;
        const res = await fetch(`${started.url}/api/archive`, { method: "POST", headers: { Authorization: `Bearer ${DRIVE}`, "Content-Type": "application/json" }, body: "{}" });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "archive_in_progress" });
      } finally {
        slot.busy = false;
        await closeServer(started.server);
      }
    });
  });
});
