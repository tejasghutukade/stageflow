import { describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import {
  registerCatalogWriteTools,
} from "../src/mcp/catalogWriteTools.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import type { IssueFetch } from "../src/config/importTask.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

type RecordedTool = {
  name: string;
  description: string;
  inputSchema: ZodType | undefined;
  handler: (args: Record<string, unknown>, ctx: unknown) => unknown;
};

type ToolPayload = {
  isError: boolean;
  payload: Record<string, unknown>;
};

const TOOL_NAMES = ["import_task"];

const MODEL = "anthropic/claude-sonnet-4-5";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function recordTools(deps: McpToolDeps & { issueFetch?: IssueFetch }): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const recorder = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodType },
      handler: RecordedTool["handler"],
    ) {
      tools.push({
        name,
        description: config.description ?? "",
        inputSchema: config.inputSchema,
        handler,
      });
    },
  };
  registerCatalogWriteTools(recorder as unknown as McpServer, deps);
  return tools;
}

async function callTool(
  tools: RecordedTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolPayload> {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, name).toBeDefined();
  const result = (await tool!.handler(args, undefined)) as {
    content: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result.content[0]?.text;
  expect(typeof text).toBe("string");
  return {
    isError: result.isError === true,
    payload: JSON.parse(text!) as Record<string, unknown>,
  };
}

async function seedCatalog(root: string): Promise<void> {
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n",
  );
}

async function withTools(
  fn: (ctx: { root: string; nested: string; tools: RecordedTool[]; store: RunStore }) => Promise<void>,
  options?: { issueFetch?: IssueFetch },
): Promise<void> {
  const { root, nested, cleanup } = await initTempGitRepo();
  const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-catalog-write-"));
  const store = createRunStore({ rootDir: storeRoot });
  try {
    await seedCatalog(root);
    clearFindProjectRootCacheForTests();
    await store.ensureProject(root);
    const tools = recordTools({
      manager: {} as McpToolDeps["manager"],
      store,
      cwd: nested,
      projectRoot: root,
      issueFetch: options?.issueFetch,
    });
    await fn({ root, nested, tools, store });
  } finally {
    clearFindProjectRootCacheForTests();
    await store.close();
    await rm(storeRoot, { recursive: true, force: true });
    await cleanup();
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validStageYaml(id: string, prompt: string): string {
  return [
    `id: ${id}`,
    "system_prompt: |",
    `  ${prompt}`,
    `model: ${MODEL}`,
    "io:",
    "  input:",
    "    schema:",
    "      type: object",
    "  output:",
    "    schema:",
    "      type: object",
    "",
  ].join("\n");
}

describe("catalog write MCP tools", () => {
  it("registers only import_task", async () => {
    await withTools(async ({ tools }) => {
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  it("import_task uses an injected fetch and returns validation errors before calling it", async () => {
    const issueFetch = vi.fn<IssueFetch>(async () => jsonResponse(404, { message: "Not Found" }));
    await withTools(
      async ({ tools }) => {
        const badRepo = await callTool(tools, "import_task", {
          repo: "not a repo",
          number: 12,
          directory: "tasks",
        });
        expect(badRepo.isError).toBe(true);
        expect(badRepo.payload).toEqual({
          error: "repo must be a GitHub owner/repo",
          status: 400,
        });

        const badNumber = await callTool(tools, "import_task", {
          repo: "acme/api",
          number: 0,
          directory: "tasks",
        });
        expect(badNumber.isError).toBe(true);
        expect(badNumber.payload).toEqual({
          error: "number must be a positive integer",
          status: 400,
        });

        const escaped = await callTool(tools, "import_task", {
          repo: "acme/api",
          number: 12,
          directory: "../outside",
        });
        expect(escaped.isError).toBe(true);
        expect(escaped.payload).toEqual({
          error: "directory must be inside the project root",
          status: 400,
        });
        expect(issueFetch).not.toHaveBeenCalled();

        const missing = await callTool(tools, "import_task", {
          repo: "acme/api",
          number: 9,
          directory: "tasks",
        });
        expect(missing.isError).toBe(true);
        expect(missing.payload).toEqual({
          error: "GitHub issue not found: acme/api#9",
          status: 404,
        });
        expect(issueFetch).toHaveBeenCalledOnce();
      },
      { issueFetch },
    );
  });

  it("import_task writes a task from a fake issue response", async () => {
    const issueFetch = vi.fn<IssueFetch>(async () =>
      jsonResponse(200, { title: "Ship the catalog tool", body: "Line one" }),
    );
    await withTools(
      async ({ root, tools }) => {
        const imported = await callTool(tools, "import_task", {
          repo: "acme/api",
          number: 3,
          directory: "tasks",
        });
        expect(imported.isError).toBe(false);
        expect(imported.payload.task).toMatchObject({
          id: "ship-the-catalog-tool",
          goal: "Ship the catalog tool",
          context: "Line one",
          path: "tasks/ship-the-catalog-tool.task.yaml",
        });
        const onDisk = await readFile(
          path.join(root, "tasks/ship-the-catalog-tool.task.yaml"),
          "utf8",
        );
        expect(onDisk).toContain("goal: Ship the catalog tool");
        expect(issueFetch).toHaveBeenCalledOnce();
      },
      { issueFetch },
    );
  });
});
