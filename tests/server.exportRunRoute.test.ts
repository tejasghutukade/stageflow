import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";
import { withIsolatedHome } from "./helpers/projectContext.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";

const READ = "r".repeat(32);
const DRIVE = "d".repeat(32);

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("GET /api/runs/:id/export", () => {
  it("refuses without a token and returns payload with read token", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const created = await store.createRun({
        pipelineId: "p",
        taskYaml: "id: t\ngoal: g\n",
        pipelineDag: linearCompatDagSnapshot(["a"]),
        runManifest: {
          manifest_version: 1,
          run_id: "pending",
          created_at: new Date().toISOString(),
          host: {
            stageflow_version: "0.24.0",
            build_sha: "t",
            image_digest: null,
            schema_version: 6,
          },
          caller: { caller_id: "default", surface: "rest" },
          binding: { kind: "unbound" },
          pipeline: {
            source: "path",
            path: null,
            bytes_sha256: "x",
            body: null,
          },
          task: {
            source: "inline",
            path: null,
            bytes_sha256: "y",
            body: "id: t\n",
          },
          skills: [],
          stages: [],
          toolchain: [],
        },
      });
      await store.updateRunStatus(created.runId, "running");

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
        const denied = await fetch(
          `${started.url}/api/runs/${encodeURIComponent(created.runId)}/export`,
        );
        expect(denied.status).toBe(401);

        const ok = await fetch(
          `${started.url}/api/runs/${encodeURIComponent(created.runId)}/export`,
          { headers: { Authorization: `Bearer ${READ}` } },
        );
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as {
          run_id: string;
          status: string;
          run_manifest: { manifest_version: number; run_id: string } | null;
          stages: unknown[];
        };
        expect(body.run_id).toBe(created.runId);
        expect(["running", "created"]).toContain(body.status);
        expect(body.run_manifest?.manifest_version).toBe(1);
        expect(body.stages).toBeDefined();
      } finally {
        await closeServer(started.server);
      }
    });
  });
});
