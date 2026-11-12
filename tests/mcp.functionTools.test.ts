import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerFunctionTools } from "../src/mcp/functionTools.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { createMcpHttpHandler } from "../src/mcp/server.js";
import { createFunctionInvoker } from "../src/functions/invoke.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { defaultAgentProjectRoot } from "../src/agents/projectRoot.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { createRunStore, createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

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
    const { store, connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const functionInvoker = createFunctionInvoker({ db: connection, env: {}, stageflowHome: home });
    const tools = record({ cwd: project, store, functionService: service, functionInvoker } as McpToolDeps);
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

    const guestRead =
      'export default async function execute(context) {\n  return { text: await context.files.readText("artifacts", "report.txt") };\n}\n';
    const guestFail = await call(tools, "test_function", { id: "score", source: guestRead });
    expect(guestFail.isError).toBe(false);
    expect(guestFail.payload).toMatchObject({ ok: false, kind: "test", code: "permission_denied" });

    const tested = await call(tools, "test_function", { id: "score" });
    expect(tested.isError).toBe(false);
    expect(tested.payload).toMatchObject({ ok: true, kind: "test", revision: 2, value: { passed: true } });

    const realTest = await call(tools, "test_function", { id: "score", real: true });
    expect(realTest.isError).toBe(false);
    expect(realTest.payload).toMatchObject({ ok: true, kind: "test", value: { passed: true } });
  });

  it("forwards function services through createMcpHttpHandler", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-mcp-http-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "sf-fn-mcp-http-project-"));
    dirs.push(home, project);
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const functionInvoker = createFunctionInvoker({ db: connection, env: {}, stageflowHome: home });
    await service.create(
      project,
      {
        id: "score",
        name: "Score",
        description: "Checks a report",
        kind: "verification",
        source: SOURCE,
        capabilities: [],
        bindings: [],
      },
      { source: "api" },
    );
    const store = createRunStore({ rootDir: home });
    const withServices = createMcpHttpHandler(
      {
        manager: {} as never,
        store,
        cwd: project,
        runChangeBus: createRunChangeBus(),
        functionService: service,
        functionInvoker,
      },
      { mcpStateless: true },
    );
    const withoutServices = createMcpHttpHandler(
      {
        manager: {} as never,
        store,
        cwd: project,
        runChangeBus: createRunChangeBus(),
      },
      { mcpStateless: true },
    );

    async function listen(handler: ReturnType<typeof createMcpHttpHandler>) {
      const server = createServer((req, res) => {
        void handler.handle(req, res).catch((error: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(String(error));
          }
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no addr");
      return {
        base: `http://127.0.0.1:${address.port}`,
        close: () =>
          Promise.all([
            handler.close(),
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
          ]),
      };
    }

    async function toolCall(base: string, name: string) {
      const res = await fetch(`${base}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
      const text = await res.text();
      const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
      const message = dataLine
        ? (JSON.parse(dataLine.slice("data: ".length)) as {
            result?: { content?: Array<{ text?: string }>; isError?: boolean };
            error?: { message?: string };
          })
        : { error: { message: text } };
      const contentText = message.result?.content?.[0]?.text ?? "";
      let payload: Record<string, unknown> | null = null;
      if (contentText.startsWith("{") || contentText.startsWith("[")) {
        payload = JSON.parse(contentText) as Record<string, unknown>;
      }
      return {
        status: res.status,
        isError: Boolean(message.result?.isError),
        payload,
        text: contentText || message.error?.message || text,
      };
    }

    const wired = await listen(withServices);
    try {
      const listed = await toolCall(wired.base, "list_functions");
      expect(listed.payload).toMatchObject({
        functions: expect.arrayContaining([expect.objectContaining({ id: "score" })]),
      });
    } finally {
      await wired.close();
    }

    const missing = await listen(withoutServices);
    try {
      const listed = await toolCall(missing.base, "list_functions");
      expect(listed.text).toMatch(/functionService/i);
    } finally {
      await missing.close();
    }
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

  it("resolves optional project_root", async () => {
    const { root: repoA, nested, cleanup: cleanupA } = await initTempGitRepo();
    const { root: repoB, cleanup: cleanupB } = await initTempGitRepo();
    closers.push(cleanupA, cleanupB);
    const home = await mkdtemp(path.join(tmpdir(), "sf-fn-mcp-roots-home-"));
    dirs.push(home);
    const { store, connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    closers.push(() => connection.close());
    clearFindProjectRootCacheForTests();
    await store.ensureProject(repoA);
    await store.ensureProject(repoB);
    const service = new FunctionService({ store: new FunctionStore(connection) });
    const functionInvoker = createFunctionInvoker({ db: connection, env: {}, stageflowHome: home });
    await service.create(repoB, definition("remote_only"), { source: "api", author: "test" });
    const tools = record({ cwd: nested, store, functionService: service, functionInvoker } as McpToolDeps);

    const local = await call(tools, "create_function", { definition: definition("local_only") });
    expect(local.isError).toBe(false);

    const defaultRoot = defaultAgentProjectRoot(nested);
    const defaulted = await call(tools, "list_functions", {});
    expect(defaulted.isError).toBe(false);
    expect(defaulted.payload.functions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local_only" })]),
    );
    expect(defaulted.payload.functions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "remote_only" })]),
    );
    expect(defaultRoot).toBe(nested);

    const remote = await call(tools, "list_functions", { project_root: repoB });
    expect(remote.isError).toBe(false);
    expect(remote.payload.functions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "remote_only" })]),
    );
    expect(remote.payload.functions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local_only" })]),
    );

    const unknown = await call(tools, "list_functions", {
      project_root: "/tmp/stageflow-function-mcp-unknown-root",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.payload).toMatchObject({ code: "unknown_project_root" });

    const readOnly = await call(tools, "create_function", {
      project_root: "examples",
      definition: definition("seeded_refuse"),
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.payload).toMatchObject({ code: "catalog_root_read_only" });

    const tested = await call(tools, "test_function", { id: "remote_only", project_root: repoB });
    expect(tested.isError).toBe(false);
    expect(tested.payload).toMatchObject({ ok: true, kind: "test", value: { passed: true } });
  });
});
