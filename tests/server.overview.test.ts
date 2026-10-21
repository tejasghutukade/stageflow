import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
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

async function withHost<T>(
  fn: (ctx: { base: string; store: ReturnType<typeof createRunStore> }) => Promise<T>,
): Promise<T> {
  return withIsolatedHome(async () => {
    const home = globalStageflowHome();
    const store = createRunStore({ rootDir: home, openerMode: "migrate" });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: home,
      rootDir: home,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: "d".repeat(32),
        STAGEFLOW_READ_TOKEN: READ,
      }),
    });
    try {
      return await fn({ base: started.url, store });
    } finally {
      await closeServer(started.server);
    }
  });
}

const auth = { Authorization: `Bearer ${READ}` };

describe("GET /api/overview", () => {
  it("summarises runs in the default 7 day window with cost and per-pipeline rows", async () => {
    await withHost(async ({ base, store }) => {
      const ok = await store.createRun({ pipelineId: "feature-ship", taskYaml: "id: t\ngoal: g\n" });
      await store.createStageExecution(ok.runId, "plan");
      await store.updateStageExecution(ok.runId, "plan", 1, { cost_usd: 0.4 });
      await store.updateRunStatus(ok.runId, "succeeded");
      const bad = await store.createRun({ pipelineId: "feature-ship", taskYaml: "id: t\ngoal: g\n" });
      await store.updateRunStatus(bad.runId, "failed");
      await store.createRun({ pipelineId: "bugfix-loop", taskYaml: "id: t\ngoal: g\n" });

      const res = await fetch(`${base}/api/overview`, { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        range: string;
        totals: { runs: number; succeeded: number; failed: number; finished: number; cost_usd: number; success_rate: number };
        buckets: unknown[];
        pipelines: Array<{ pipeline_id: string; runs: number; cost_usd: number }>;
      };
      expect(body.range).toBe("7d");
      expect(body.buckets).toHaveLength(7);
      expect(body.totals).toMatchObject({ runs: 3, succeeded: 1, failed: 1, finished: 2, cost_usd: 0.4, success_rate: 0.5 });
      expect(body.pipelines.map((p) => [p.pipeline_id, p.runs])).toEqual([
        ["feature-ship", 2],
        ["bugfix-loop", 1],
      ]);
    });
  });

  it("accepts a range and rejects an unknown one", async () => {
    await withHost(async ({ base }) => {
      const day = await fetch(`${base}/api/overview?range=24h`, { headers: auth });
      expect(day.status).toBe(200);
      expect(((await day.json()) as { buckets: unknown[] }).buckets).toHaveLength(8);

      const bad = await fetch(`${base}/api/overview?range=1y`, { headers: auth });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ code: "invalid_range" });
    });
  });
});
