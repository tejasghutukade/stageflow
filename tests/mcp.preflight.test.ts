import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { TOOLCHAIN_MANIFEST_ENV } from "../src/preflight/toolchain.js";
import type { RunStore } from "../src/runstore/port.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function completedAgent() {
  return {
    startStage: async () => createCompletedOnlyStageHandle(),
  };
}

describe("MCP preflight", () => {
  let catalogRoot: string;
  let cleanupCatalogRoot: () => Promise<void>;
  let home: string;
  let store: RunStore;
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    catalogRoot = setup.root;
    cleanupCatalogRoot = setup.cleanup;
    await cp(path.join(fixtures, "pipelines"), path.join(catalogRoot, "pipelines"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "tasks"), path.join(catalogRoot, "tasks"), {
      recursive: true,
    });
    await cp(path.join(fixtures, "stages"), path.join(catalogRoot, "stages"), {
      recursive: true,
    });
    await writeFile(
      path.join(catalogRoot, "stageflow.yaml"),
      [
        "version: 1",
        "catalog:",
        "  pipelines:",
        "    - pipelines",
        "  tasks:",
        "    - tasks",
        "  patterns:",
        '    pipeline: "*.yaml"',
        '    task: "*.yaml"',
        "",
      ].join("\n"),
    );
    clearFindProjectRootCacheForTests();

    home = await mkdtemp(path.join(tmpdir(), "sf-mcp-preflight-"));
    const manifestPath = path.join(home, "toolchain.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        tools: {
          node: { path: "/usr/bin/node", version: "22.19.0" },
          pnpm: { path: "/usr/bin/pnpm", version: "9.0.0" },
          git: { path: "/usr/bin/git", version: "2.43.0" },
        },
      }),
    );
    process.env[TOOLCHAIN_MANIFEST_ENV] = manifestPath;

    store = createRunStore({ rootDir: home, openerMode: "migrate" });
    await store.ensureProject(catalogRoot);
    const { server } = await startUiServer({
      agent: completedAgent(),
      cwd: catalogRoot,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    base = `http://127.0.0.1:${address.port}`;
    close = async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    };
  });

  afterAll(async () => {
    delete process.env[TOOLCHAIN_MANIFEST_ENV];
    clearFindProjectRootCacheForTests();
    if (close) await close();
    if (store) await store.close();
    if (cleanupCatalogRoot) await cleanupCatalogRoot();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("path pipeline returns tool_version_mismatch and creates no Run", async () => {
    const before = await store.listRuns();
    const result = await mcpCall(base, "preflight", {
      pipeline: "pipelines/requires-demo.pipeline.yaml",
    });
    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.code).toBe("tool_version_mismatch");
    expect(
      result.payload.checks.some(
        (c: { status: string; tool?: string }) =>
          c.status === "tool_version_mismatch" && c.tool === "pnpm",
      ),
    ).toBe(true);
    const after = await store.listRuns();
    expect(after.length).toBe(before.length);
  });

  it("inline pipeline preflight works without creating a Run", async () => {
    const before = await store.listRuns();
    const result = await mcpCall(base, "preflight", {
      pipeline: {
        id: "inline-missing",
        requires: [{ tool: "totally-absent-bin-xyz" }],
        stages: [
          {
            id: "a",
            system_prompt: "hi",
            model: "anthropic/claude-sonnet-4-5",
            io: {
              input: { schema: { type: "object" } },
              output: { schema: { type: "object" } },
            },
          },
        ],
      },
    });
    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.code).toBe("missing_tool");
    const after = await store.listRuns();
    expect(after.length).toBe(before.length);
  });

  it("start_run fails with same code and creates no Run", async () => {
    const before = await store.listRuns();
    const result = await mcpCall(base, "start_run", {
      pipeline: "pipelines/requires-demo.pipeline.yaml",
      task_path: "tasks/sample.task.yaml",
    });
    expect(result.isError).toBe(true);
    expect(result.payload.code).toBe("tool_version_mismatch");
    const after = await store.listRuns();
    expect(after.length).toBe(before.length);
  });

  it("get_health includes toolchain map", async () => {
    const result = await mcpCall(base, "get_health");
    expect(result.isError).toBe(false);
    expect(result.payload.toolchain).toEqual(
      expect.objectContaining({
        node: "22.19.0",
        pnpm: "9.0.0",
        git: "2.43.0",
      }),
    );
  });
});
