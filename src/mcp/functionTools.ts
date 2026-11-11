import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import type { FunctionInvoker } from "../functions/invoke.js";
import { isFunctionError } from "../functions/service.js";
import type { FunctionService } from "../functions/service.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const functionId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const MCP_ACTOR = { source: "api" as const, author: "mcp" };

function required(deps: McpToolDeps): FunctionService {
  if (!deps.functionService) throw new Error("MCP function tools require functionService from host bootstrap");
  return deps.functionService;
}

function invoker(deps: McpToolDeps): FunctionInvoker {
  if (!deps.functionInvoker) throw new Error("MCP function tools require functionInvoker from host bootstrap");
  return deps.functionInvoker;
}

async function call(work: () => Promise<unknown>) {
  try {
    return textResult(await work());
  } catch (error) {
    if (isFunctionError(error)) {
      return textResult(
        {
          code: error.code,
          message: error.message,
          ...(error.currentRevision !== undefined ? { current_revision: error.currentRevision } : {}),
          ...(error.usages ? { usages: error.usages } : {}),
          ...(error.issues.length > 0 ? { issues: error.issues } : {}),
        },
        true,
      );
    }
    throw error;
  }
}

export function registerFunctionTools(server: McpServer, deps: McpToolDeps): void {
  const service = () => required(deps);
  const root = () => defaultAgentProjectRoot(deps.cwd);

  server.registerTool(
    "list_functions",
    { description: "List function definitions in functions/*.function.yaml.", inputSchema: z.object({}) },
    () => call(async () => ({ functions: await service().list(root()) })),
  );

  server.registerTool(
    "get_function",
    { description: "Get one function definition and its current revision.", inputSchema: z.object({ id: functionId }) },
    ({ id }) => call(() => service().get(root(), id)),
  );

  server.registerTool(
    "list_function_revisions",
    { description: "List the revisions of a function.", inputSchema: z.object({ id: functionId }) },
    ({ id }) => call(async () => ({ revisions: await service().listRevisions(root(), id) })),
  );

  server.registerTool(
    "get_function_revision",
    {
      description: "Get one stored revision of a function.",
      inputSchema: z.object({ id: functionId, revision: z.number().int().positive() }),
    },
    ({ id, revision }) => call(() => service().getRevision(root(), id, revision)),
  );

  server.registerTool(
    "create_function",
    {
      description: "Create a function definition.",
      inputSchema: z.object({ definition: z.record(z.string(), z.unknown()) }),
    },
    ({ definition }) => call(() => service().create(root(), definition, MCP_ACTOR)),
  );

  server.registerTool(
    "save_function",
    {
      description: "Save a function definition. baseRevision must be the current revision.",
      inputSchema: z.object({
        id: functionId,
        baseRevision: z.number().int().nonnegative(),
        definition: z.record(z.string(), z.unknown()),
        summary: z.string().max(200).optional(),
      }),
    },
    ({ id, baseRevision, definition, summary }) =>
      call(() => service().save(root(), id, { baseRevision, definition, summary: summary ?? null }, MCP_ACTOR)),
  );

  server.registerTool(
    "duplicate_function",
    {
      description: "Copy a function to a new id with its own revision history.",
      inputSchema: z.object({ id: functionId, newId: functionId }),
    },
    ({ id, newId }) => call(() => service().duplicate(root(), id, { id: newId }, MCP_ACTOR)),
  );

  server.registerTool(
    "test_function",
    {
      description: "Test a function with the production executor. real is the only way to use real files, environment, or APIs.",
      inputSchema: z.object({
        id: functionId,
        source: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        real: z.boolean().optional(),
        mocks: z
          .object({
            files: z
              .array(z.object({ root: z.enum(["artifacts", "workspace"]), path: z.string(), text: z.string() }))
              .optional(),
            env: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
        timeoutMs: z.number().int().positive().optional(),
        memoryLimitBytes: z.number().int().positive().optional(),
      }),
    },
    ({ id, source, input, real, mocks, timeoutMs, memoryLimitBytes }) =>
      call(() =>
        invoker(deps).test(root(), id, {
          ...(source !== undefined ? { source } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(real !== undefined ? { real } : {}),
          ...(mocks !== undefined ? { mocks } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
        }),
      ),
  );

  server.registerTool(
    "delete_function",
    {
      description: "Delete a function that no pipeline, stage, or agent references.",
      inputSchema: z.object({ id: functionId }),
    },
    ({ id }) => call(() => service().delete(root(), id)),
  );
}
