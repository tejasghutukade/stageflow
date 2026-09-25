import { describe, expect, it } from "vitest";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  return { status: res.status, body };
}

describe("catalog surface parity", () => {
  it("HTTP and MCP agree on manifest browse and path-based run locators", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-parity-"));
    const { root: repoRoot, cleanup } = await initTempGitRepo();
    await cp(manifestCatalog, repoRoot, { recursive: true });
    clearFindProjectRootCacheForTests();

    const store = createRunStore({ rootDir: storeRoot });
    await store.ensureProject(repoRoot);
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "ok", artifacts: [] },
      },
    ]);

    const { server } = await startUiServer({
      agent,
      cwd: repoRoot,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
      mcpStateless: true,
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address");
      const base = `http://127.0.0.1:${address.port}`;

      // REST and MCP share one multi-project catalog path; both tag entries with project_root.
      const httpPipelines = await jsonFetch(`${base}/api/pipelines`);
      const mcpPipelines = await mcpCall(base, "list_pipelines");
      expect(mcpPipelines.payload.pipelines).toEqual(
        httpPipelines.body.pipelines,
      );

      const httpTasks = await jsonFetch(`${base}/api/tasks`);
      const mcpTasks = await mcpCall(base, "list_tasks");
      expect(mcpTasks.payload.tasks).toEqual(httpTasks.body.tasks);

      const pipelinePath = "pipelines/demo.pipeline.yaml";
      const taskPath = "tasks/demo.task.yaml";
      const started = await jsonFetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: pipelinePath, task: taskPath }),
      });
      expect(started.status).toBe(202);
      const runId = started.body.runId as string;

      const httpRun = await jsonFetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
      const mcpRun = await mcpCall(base, "get_run", { runId });
      expect(mcpRun.payload.pipeline_path).toBe(httpRun.body.pipeline_path);
      expect(mcpRun.payload.task_path).toBe(httpRun.body.task_path);
      expect(mcpRun.payload.project_root).toBe(httpRun.body.project_root);
    } finally {
      clearFindProjectRootCacheForTests();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await cleanup();
    }
  });
});
