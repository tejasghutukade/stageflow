import { describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
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

describe("GET /api/export mid-stream failure", () => {
  it("destroys the response after headers when iteration throws", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      const store = createRunStore({ rootDir: home, openerMode: "migrate" });
      const original = store.readRun.bind(store);
      let armFailure = false;
      let reads = 0;
      (store as RunStore).readRun = async (runId: string) => {
        const detail = await original(runId);
        if (armFailure) {
          reads += 1;
          if (reads >= 2) {
            throw new Error("mid-stream boom");
          }
        }
        return detail;
      };

      const tokens = loadControlTokens({
        STAGEFLOW_CONTROL_TOKEN: "d".repeat(32),
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
        await store.createRun({
          pipelineId: "p",
          taskYaml: "id: t\ngoal: g\n",
        });
        await store.createRun({
          pipelineId: "p",
          taskYaml: "id: t\ngoal: g\n",
        });
        armFailure = true;

        let thrown: unknown;
        try {
          const res = await fetch(`${started.url}/api/export`, {
            headers: { Authorization: `Bearer ${READ}` },
          });
          await res.arrayBuffer();
          thrown = new Error(`unexpected status ${res.status}`);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(String(thrown)).toMatch(
          /mid-stream boom|network|fetch|ECONNRESET|aborted/i,
        );
      } finally {
        await closeServer(started.server);
      }
    });
  });
});
