import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { placeGuideWriteArgs } from "../src/guide/writeRoot.js";
import { forbiddenWriteTarget } from "../src/agents/policy.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";

const MODEL = "anthropic/claude-sonnet-4-5";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

async function withAuthoringServer(
  fn: (ctx: { base: string; root: string; close: () => Promise<void> }) => Promise<void>,
) {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-authoring-"));
  const { root, cleanup } = await initTempGitRepo();
  await writeFile(
    path.join(root, "stageflow.yaml"),
  `version: 1
catalog:
  pipelines:
    - pipelines
  tasks:
    - tasks
`,
  );
  clearFindProjectRootCacheForTests();
  const store = createRunStore({ rootDir: storeRoot });
  await store.ensureProject(root);
  const { server } = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: root,
    store,
    port: 0,
    uiDistDir: path.join(storeRoot, "missing-ui"),
    mcpStateless: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await store.close();
    clearFindProjectRootCacheForTests();
    await cleanup();
  };
  try {
    await fn({ base, root, close });
  } finally {
    await close();
  }
}

describe("consolidated authoring MCP tools", () => {
  it("write_task without a pipeline creates a standalone task file", async () => {
    await withAuthoringServer(async ({ base }) => {
      const created = await mcpCall(base, "write_task", {
        mode: "create",
        directory: "tasks",
        id: "solo-task",
        goal: "Ship consolidated tools",
      });
      expect(created.isError).toBe(false);
      expect(created.payload.task).toMatchObject({
        id: "solo-task",
        path: "tasks/solo-task.task.yaml",
      });
    });
  });

  it("write_stage rejects patch and content together", async () => {
    await withAuthoringServer(async ({ base }) => {
      const result = await mcpCall(base, "write_stage", {
        mode: "update",
        path: "stages/x.yaml",
        id: "x",
        patch: { system_prompt: "a" },
        content: "id: x\n",
      });
      expect(result.isError).toBe(true);
    });
  });

  it("write_stage standalone create returns stage_EXISTS on duplicate id", async () => {
    await withAuthoringServer(async ({ base }) => {
      const first = await mcpCall(base, "write_stage", {
        mode: "create",
        pipeline_directory: "stages",
        filename: "a.yaml",
        id: "alpha",
        system_prompt: "One",
        model: MODEL,
      });
      expect(first.isError).toBe(false);
      const dup = await mcpCall(base, "write_stage", {
        mode: "create",
        pipeline_directory: "stages",
        filename: "b.yaml",
        id: "alpha",
        system_prompt: "Two",
        model: MODEL,
      });
      expect(dup.isError).toBe(true);
      expect(dup.payload.code).toBe("stage_EXISTS");
    });
  });

  it("validate kind draft mirrors former validate_catalog_draft", async () => {
    await withAuthoringServer(async ({ base }) => {
      const valid = await mcpCall(base, "validate", {
        kind: "draft",
        draft: {
          pipeline: {
            id: "inline-demo",
            stages: [{ id: "plan", system_prompt: "Do work", model: MODEL, ...REQUIRED_IO }],
          },
        },
      });
      expect(valid.isError).toBe(false);
      expect(valid.payload.ok).toBe(true);
    });
  });

  it("Guide placement matches standalone create_stage_file for write_stage", () => {
    const placed = placeGuideWriteArgs("write_stage", {
      mode: "create",
      pipeline_directory: "/elsewhere",
      filename: "review.yaml",
      id: "policy-check",
      system_prompt: "Review",
    });
    expect(placed).toEqual({
      ok: true,
      args: {
        mode: "create",
        pipeline_directory: "pipelines/policy-check",
        filename: "review.yaml",
        id: "policy-check",
        system_prompt: "Review",
      },
    });
  });

  it("write_stage content mode refuses agents/ paths for agent callers", () => {
    const home = process.env.STAGEFLOW_HOME ?? path.join(tmpdir(), "sf-home");
    const forbidden = forbiddenWriteTarget("/proj", home, "write_stage", {
      path: "agents/support.agent.yaml",
      mode: "update",
      content: "id: support\n",
    });
    expect(forbidden).toBe("agents/support.agent.yaml");
  });
});