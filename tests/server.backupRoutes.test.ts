import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { backupsDir } from "../src/runstore/backup.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("backup HTTP routes", () => {
  it("POST creates backup; drive GET streams; read token forbidden; traversal rejected", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      mkdirSync(path.join(home, "agent"), { recursive: true });
      writeFileSync(path.join(home, "agent", "auth.json"), '{"x":1}\n', {
        mode: 0o600,
      });
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const tokens = loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: DRIVE,
        STAGEFLOW_READ_TOKEN: READ,
      });
      const started = await startMcpServer({
        agent: scriptedFakeAgent([]),
        cwd: home,
        rootDir: home,
        store,
        port: 0,
        mcpStateless: true,
        controlTokens: tokens,
      });
      try {
        const createRes = await fetch(`${started.url}/api/backup`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DRIVE}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ db_only: true }),
        });
        expect(createRes.status).toBe(200);
        const meta = (await createRes.json()) as {
          path: string;
          bytes: number;
          sha256: string;
        };
        expect(meta.bytes).toBeGreaterThan(0);
        expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
        const name = path.basename(meta.path);

        const readGet = await fetch(`${started.url}/api/backup/${name}`, {
          headers: { Authorization: `Bearer ${READ}` },
        });
        expect(readGet.status).toBe(403);

        const driveGet = await fetch(`${started.url}/api/backup/${name}`, {
          headers: { Authorization: `Bearer ${DRIVE}` },
        });
        expect(driveGet.status).toBe(200);
        const bytes = Buffer.from(await driveGet.arrayBuffer());
        expect(bytes.length).toBe(meta.bytes);

        const traversal = await fetch(
          `${started.url}/api/backup/${encodeURIComponent("../../etc/passwd")}`,
          { headers: { Authorization: `Bearer ${DRIVE}` } },
        );
        expect(traversal.status).toBe(400);

        const partialCase = await fetch(
          `${started.url}/api/backup/${encodeURIComponent("snap.PARTIAL")}`,
          { headers: { Authorization: `Bearer ${DRIVE}` } },
        );
        expect(partialCase.status).toBe(400);

        const dir = backupsDir(home);
        mkdirSync(dir, { recursive: true });
        const partialPath = path.join(dir, "incomplete.tar.gz.partial");
        writeFileSync(partialPath, "incomplete");
        const linkName = "looks-ok.tar.gz";
        symlinkSync(partialPath, path.join(dir, linkName));
        const partialLink = await fetch(
          `${started.url}/api/backup/${encodeURIComponent(linkName)}`,
          { headers: { Authorization: `Bearer ${DRIVE}` } },
        );
        expect(partialLink.status).toBe(400);
      } finally {
        await closeServer(started.server);
      }
    });
  });
});
