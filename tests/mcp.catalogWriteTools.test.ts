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

const TOOL_NAMES = [
  "create_task_file",
  "update_task_file",
  "import_task_file",
  "create_stage_file",
  "write_catalog_file",
  "validate_catalog_draft",
];

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
  it("registers the six file-level tools", async () => {
    await withTools(async ({ tools }) => {
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  it("create_task_file writes under the server project root and returns parse errors", async () => {
    await withTools(async ({ root, nested, tools }) => {
      const created = await callTool(tools, "create_task_file", {
        directory: "tasks",
        id: "fresh-task",
        goal: "Ship it",
        context: "notes",
        constraints: "keep the id",
      });
      expect(created.isError).toBe(false);
      expect(created.payload.task).toMatchObject({
        id: "fresh-task",
        goal: "Ship it",
        context: "notes",
        constraints: "keep the id",
        path: "tasks/fresh-task.task.yaml",
      });
      const onDisk = await readFile(path.join(root, "tasks/fresh-task.task.yaml"), "utf8");
      expect(onDisk).toContain("goal: Ship it");
      await expect(access(path.join(nested, "tasks/fresh-task.task.yaml"))).rejects.toThrow();

      const explicit = await callTool(tools, "create_task_file", {
        project_root: nested,
        directory: "tasks",
        id: "nested-task",
        goal: "Written to the explicit root",
      });
      expect(explicit.isError).toBe(false);
      const nestedFile = await readFile(path.join(nested, "tasks/nested-task.task.yaml"), "utf8");
      expect(nestedFile).toContain("goal: Written to the explicit root");

      const badId = await callTool(tools, "create_task_file", {
        directory: "tasks",
        id: "Bad_Id",
        goal: "Ship it",
      });
      expect(badId.isError).toBe(true);
      expect(badId.payload).toEqual({
        error: "id must be lowercase kebab-case",
        status: 400,
      });

      const duplicate = await callTool(tools, "create_task_file", {
        directory: "tasks",
        id: "fresh-task",
        goal: "Again",
      });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.payload).toMatchObject({ status: 409 });
      expect(duplicate.payload.error).toMatch(/already exists/);

      const escaped = await callTool(tools, "create_task_file", {
        directory: "../outside",
        id: "escaped-task",
        goal: "Nope",
      });
      expect(escaped.isError).toBe(true);
      expect(escaped.payload).toEqual({
        error: "directory must be inside the project root",
        status: 400,
      });
    });
  });

  it("update_task_file changes the goal, clears a field, and returns lookup codes", async () => {
    await withTools(async ({ root, tools }) => {
      const created = await callTool(tools, "create_task_file", {
        directory: "tasks",
        id: "my-task",
        goal: "Say hello",
        context: "keep this",
      });
      expect(created.isError).toBe(false);

      const updated = await callTool(tools, "update_task_file", {
        id: "my-task",
        goal: "A new goal",
        context: null,
      });
      expect(updated.isError).toBe(false);
      expect(updated.payload.task).toMatchObject({
        id: "my-task",
        goal: "A new goal",
      });
      const onDisk = await readFile(path.join(root, "tasks/my-task.task.yaml"), "utf8");
      expect(onDisk).toContain("goal: A new goal");
      expect(onDisk).not.toMatch(/^context:/m);

      const missing = await callTool(tools, "update_task_file", {
        id: "no-such-task",
        goal: "Missing",
      });
      expect(missing.isError).toBe(true);
      expect(missing.payload).toMatchObject({ status: 404 });

      const unknownRoot = await callTool(tools, "update_task_file", {
        project_root: "/tmp/stageflow-catalog-write-missing-root",
        id: "my-task",
        goal: "Elsewhere",
      });
      expect(unknownRoot.isError).toBe(true);
      expect(unknownRoot.payload).toMatchObject({
        status: 400,
        code: "unknown_project_root",
      });
    });
  });

  it("import_task_file uses an injected fetch and returns validation errors before calling it", async () => {
    const issueFetch = vi.fn<IssueFetch>(async () => jsonResponse(404, { message: "Not Found" }));
    await withTools(
      async ({ tools }) => {
        const badRepo = await callTool(tools, "import_task_file", {
          repo: "not a repo",
          number: 12,
          directory: "tasks",
        });
        expect(badRepo.isError).toBe(true);
        expect(badRepo.payload).toEqual({
          error: "repo must be a GitHub owner/repo",
          status: 400,
        });

        const badNumber = await callTool(tools, "import_task_file", {
          repo: "acme/api",
          number: 0,
          directory: "tasks",
        });
        expect(badNumber.isError).toBe(true);
        expect(badNumber.payload).toEqual({
          error: "number must be a positive integer",
          status: 400,
        });

        const escaped = await callTool(tools, "import_task_file", {
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

        const missing = await callTool(tools, "import_task_file", {
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

  it("import_task_file writes a task from a fake issue response", async () => {
    const issueFetch = vi.fn<IssueFetch>(async () =>
      jsonResponse(200, { title: "Ship the catalog tool", body: "Line one" }),
    );
    await withTools(
      async ({ root, tools }) => {
        const imported = await callTool(tools, "import_task_file", {
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

  it("create_stage_file writes an unwired stage and returns collision and gate errors", async () => {
    await withTools(async ({ root, tools }) => {
      const created = await callTool(tools, "create_stage_file", {
        pipeline_directory: "stages",
        filename: "plan.yaml",
        id: "plan",
        system_prompt: "Do the thing.",
        model: MODEL,
        gate_kinds: ["confirm"],
        skill: "archify",
      });
      expect(created.isError).toBe(false);
      expect(created.payload).toMatchObject({
        path: "stages/plan.yaml",
        id: "plan",
        gate_kinds: ["confirm"],
      });
      const onDisk = await readFile(path.join(root, "stages/plan.yaml"), "utf8");
      expect(onDisk).toContain("skill: archify");
      expect(onDisk).toContain(`model: ${MODEL}`);

      const duplicate = await callTool(tools, "create_stage_file", {
        pipeline_directory: "stages",
        filename: "other.yaml",
        id: "plan",
        system_prompt: "Again.",
      });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.payload).toMatchObject({ status: 409 });
      expect(duplicate.payload.error).toMatch(/Stage id already exists/);

      const badGate = await callTool(tools, "create_stage_file", {
        pipeline_directory: "stages",
        filename: "bad.yaml",
        id: "bad-gate",
        system_prompt: "Nope.",
        gate_kinds: ["nope"],
      });
      expect(badGate.isError).toBe(true);
      expect(badGate.payload.status).toBe(400);
      expect(badGate.payload.error).toMatch(/gate_kinds must be an array of/);

      const legacy = await callTool(tools, "create_stage_file", {
        pipeline_directory: "stages",
        filename: "legacy.yaml",
        id: "legacy",
        system_prompt: "Nope.",
        payload_schema: { type: "object" },
      });
      expect(legacy.isError).toBe(true);
      expect(legacy.payload).toEqual({
        error: "payload_schema is not supported",
        status: 400,
      });
    });
  });

  it("write_catalog_file overwrites a stage file and returns its error codes", async () => {
    await withTools(async ({ root, tools }) => {
      const created = await callTool(tools, "create_stage_file", {
        pipeline_directory: "stages",
        filename: "step.yaml",
        id: "step",
        system_prompt: "Original prompt.",
        model: MODEL,
      });
      expect(created.isError).toBe(false);

      const next = validStageYaml("step", "Updated prompt.");
      const saved = await callTool(tools, "write_catalog_file", {
        path: "stages/step.yaml",
        content: next,
      });
      expect(saved.isError).toBe(false);
      expect(saved.payload).toEqual({ path: "stages/step.yaml", content: next });
      expect(await readFile(path.join(root, "stages/step.yaml"), "utf8")).toBe(next);

      const invalid = await callTool(tools, "write_catalog_file", {
        path: "stages/step.yaml",
        content: "id: step\n",
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.payload).toMatchObject({ status: 400, code: "stage_invalid" });
      expect(Array.isArray(invalid.payload.findings)).toBe(true);
      expect(invalid.payload.content).toBeUndefined();
      expect(await readFile(path.join(root, "stages/step.yaml"), "utf8")).toBe(next);

      const missing = await callTool(tools, "write_catalog_file", {
        path: "stages/missing.yaml",
        content: next,
      });
      expect(missing.isError).toBe(true);
      expect(missing.payload).toMatchObject({
        status: 404,
        code: "catalog_file_not_found",
      });

      const wrongType = await callTool(tools, "write_catalog_file", {
        path: "stages/step.txt",
        content: next,
      });
      expect(wrongType.isError).toBe(true);
      expect(wrongType.payload).toMatchObject({
        status: 400,
        code: "unsupported_file_type",
      });

      const escaped = await callTool(tools, "write_catalog_file", {
        path: "../outside.yaml",
        content: next,
      });
      expect(escaped.isError).toBe(true);
      expect(escaped.payload).toMatchObject({
        status: 400,
        code: "path_outside_project_root",
      });
    });
  });

  it("validate_catalog_draft returns the validation result and parse errors", async () => {
    await withTools(async ({ tools }) => {
      const valid = await callTool(tools, "validate_catalog_draft", {
        draft: {
          pipeline: {
            id: "inline-demo",
            stages: [
              {
                id: "plan",
                system_prompt: "Do work",
                model: MODEL,
                ...REQUIRED_IO,
              },
            ],
          },
        },
      });
      expect(valid.isError).toBe(false);
      expect(valid.payload.ok).toBe(true);
      expect(valid.payload.summary).toMatchObject({ errors: 0 });

      const invalid = await callTool(tools, "validate_catalog_draft", {
        pipeline: {
          id: "inline-demo",
          stages: [{ id: "plan" }],
        },
      });
      expect(invalid.isError).toBe(false);
      expect(invalid.payload.ok).toBe(false);
      const findings = invalid.payload.findings as Array<{ code: string }>;
      expect(findings.length).toBeGreaterThan(0);
      expect(typeof findings[0]?.code).toBe("string");

      const missing = await callTool(tools, "validate_catalog_draft", {});
      expect(missing.isError).toBe(true);
      expect(missing.payload).toEqual({
        error: "draft.pipeline is required",
        status: 400,
      });
    });
  });
});
