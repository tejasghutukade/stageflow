import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerFunctionTools } from "../src/mcp/functionTools.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";

const SOURCE = "export default function execute(context) {\n  return { passed: true };\n}\n";

function definition(id: string, description = "Checks a report") {
  return {
    id,
    name: `Function ${id}`,
    description,
    kind: "verification",
    source: SOURCE,
    capabilities: [],
    bindings: [],
  };
}

type RecordedTool = {
  name: string;
  handler: (args: Record<string, unknown>, ctx: unknown) => unknown;
};

function record(deps: McpToolDeps): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const recorder = {
    registerTool(
      name: string,
      _config: { description?: string; inputSchema?: ZodType },
      handler: RecordedTool["handler"],
    ) {
      tools.push({ name, handler });
    },
  };
  registerFunctionTools(recorder as unknown as McpServer, deps);
  return tools;
}

async function call(tools: RecordedTool[], name: string, args: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, name).toBeDefined();
  const result = (await tool!.handler(args, undefined)) as { content: Array<{ text?: string }>; isError?: boolean };
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>,
  };
}

describe("function MCP tools", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function open() {
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-mcp-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-fn-mcp-project-"));
    dirs.push(home, project);
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const functionInvoker = createFunctionInvoker({ db: connection, env: {}, stageflowHome: home });
    const tools = record({ cwd: project, functionService: service, functionInvoker } as McpToolDeps);
    return { project, tools };
  }

  it("creates, conflicts, duplicates, refuses a referenced delete, and tests the saved revision", async () => {
    const { project, tools } = await open();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_functions",
      "get_function",
      "list_function_revisions",
      "get_function_revision",
      "create_function",
      "save_function",
      "duplicate_function",
      "test_function",
      "delete_function",
    ]);

    const created = await call(tools, "create_function", { definition: definition("score") });
    expect(created.isError).toBe(false);
    expect(created.payload).toMatchObject({ id: "score", revision: 1 });

    const first = call(tools, "save_function", { id: "score", baseRevision: 1, definition: definition("score", "one") });
    const second = call(tools, "save_function", { id: "score", baseRevision: 1, definition: definition("score", "two") });
    const settled = await Promise.all([first, second]);
    const failed = settled.filter((result) => result.isError);
    const saved = settled.filter((result) => !result.isError);
    expect(saved).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ code: "function.conflict", current_revision: 2 });

    const copy = await call(tools, "duplicate_function", { id: "score", newId: "score_copy" });
    expect(copy.isError).toBe(false);
    expect(copy.payload).toMatchObject({ id: "score_copy", revision: 1 });

    await writeFile(
      path.join(project, "stageflow.yaml"),
      ["version: 1", "catalog:", "  pipelines:", "    - .", "  tasks: []", "  patterns:", "    pipeline: '*.pipeline.yaml'", "    task: '*.task.yaml'", ""].join("\n"),
    );
    await writeFile(
      path.join(project, "uses-score.pipeline.yaml"),
      ["id: uses_score", "stages:", "  - id: check", "    function: score", ""].join("\n"),
    );
    const removed = await call(tools, "delete_function", { id: "score" });
    expect(removed.isError).toBe(true);
    expect(removed.payload).toMatchObject({ code: "function.in_use" });

    const tested = await call(tools, "test_function", { id: "score" });
    expect(tested.isError).toBe(false);
    expect(tested.payload).toMatchObject({ ok: true, kind: "test", revision: 2, value: { passed: true } });
  });

  it("derives capabilities from a declared source and rejects a conflicting list", async () => {
    const { tools } = await open();
    const source = 'export const access = { artifacts: "read", env: ["MIN_SCORE"], network: [] };\nexport default function execute(){ return { passed: true }; }\n';
    const created = await call(tools, "create_function", {
      definition: { id: "declared", name: "Declared", kind: "verification", source },
    });
    expect(created.isError).toBe(false);
    const fetched = await call(tools, "get_function", { id: "declared" });
    expect(fetched.isError).toBe(false);
    expect(fetched.payload).toMatchObject({
      definition: {
        capabilities: [
          { id: "artifacts", type: "file", root: "artifacts", path: "", access: "read" },
          { id: "env_min_score", type: "env", alias: "MIN_SCORE" },
        ],
        bindings: [{ alias: "MIN_SCORE", required: true }],
      },
    });
    const conflict = await call(tools, "create_function", {
      definition: {
        id: "wide",
        name: "Wide",
        kind: "verification",
        source,
        capabilities: [{ id: "workspace", type: "file", root: "workspace", path: "", access: "read" }],
      },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.payload).toMatchObject({
      code: "function.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ code: "function.access_conflict", path: "capabilities" })]),
    });
  });
});
