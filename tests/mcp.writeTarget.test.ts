import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { resetWorkspaceProvisionForTests, workspaceCatalogPath } from "../src/project/workspaceCatalog.js";
import { mcpCall } from "./helpers/mcpCall.js";

const exists = (p: string) => access(p).then(() => true, () => false);

describe("MCP write tools target the Host workspace", () => {
  let home: string;
  let unrelated: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-wt-home-"));
    unrelated = await mkdtemp(path.join(tmpdir(), "sf-wt-cwd-"));
    prevHome = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    resetWorkspaceProvisionForTests();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = prevHome;
    resetGlobalStageflowHomeForTests();
    resetWorkspaceProvisionForTests();
    await rm(home, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  });

  async function withHost(fn: (base: string) => Promise<void>) {
    const store = createRunStore({ rootDir: path.join(home, "store") });
    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: unrelated,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    try {
      await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await store.close();
    }
  }

  it("write_pipeline without project_root lands in workspace, not the Host cwd, and names project and link", async () => {
    await withHost(async (base) => {
      const result = await mcpCall(base, "write_pipeline", {
        mode: "create",
        directory: "pipelines",
        id: "wt-demo",
        model: "anthropic/claude-sonnet-4-5",
        allow_invalid: true,
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const workspace = workspaceCatalogPath();
      expect(result.payload.project_root).toBe("workspace");
      expect(await realpathOf(result.payload.project_path)).toBe(await realpathOf(workspace));
      expect(result.payload.console_url).toBe(`${base}/#/pipelines/wt-demo`);
      expect(await exists(path.join(workspace, "pipelines", "wt-demo.pipeline.yaml"))).toBe(true);
      expect(await exists(path.join(unrelated, "pipelines", "wt-demo.pipeline.yaml"))).toBe(false);
    });
  });

  it("write_task without project_root lands in workspace and names the project", async () => {
    await withHost(async (base) => {
      const result = await mcpCall(base, "write_task", {
        mode: "create",
        directory: "tasks",
        id: "wt-task",
        goal: "Check the target",
      });
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(result.payload.project_root).toBe("workspace");
      expect(await exists(path.join(workspaceCatalogPath(), "tasks", "wt-task.task.yaml"))).toBe(true);
      expect(await exists(path.join(unrelated, "tasks", "wt-task.task.yaml"))).toBe(false);
    });
  });

  it("an explicit workspace id and an explicit registered path are both honored", async () => {
    await withHost(async (base) => {
      const named = await mcpCall(base, "write_task", {
        mode: "create",
        directory: "tasks",
        id: "named-task",
        goal: "g",
        project_root: "workspace",
      });
      expect(named.payload.project_root).toBe("workspace");
      const other = await mkdtemp(path.join(tmpdir(), "sf-wt-other-"));
      try {
        const explicit = await mcpCall(base, "write_task", {
          mode: "create",
          directory: "tasks",
          id: "path-task",
          goal: "g",
          project_root: other,
        });
        expect(explicit.isError).toBe(false);
        expect(await exists(path.join(other, "tasks", "path-task.task.yaml"))).toBe(true);
        expect(explicit.payload.project_root).not.toBe("workspace");
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p).catch(() => p);
}
