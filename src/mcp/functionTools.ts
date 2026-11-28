import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveCatalogStartInput,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import type { FunctionInvoker } from "../functions/invoke.js";
import { isFunctionError } from "../functions/service.js";
import type { FunctionService } from "../functions/service.js";
import { getFunctionFlatSchema, saveFunctionFlatSchema } from "../toolkit/agentFunctionToolModes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { consoleUrl, targetForPath, withProject } from "./writeTarget.js";

const functionId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const projectRootField = z.string().optional();
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
    if (error instanceof CatalogPathError) {
      return textResult(catalogPathErrorBody(error), true);
    }
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

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

export function registerFunctionTools(server: McpServer, deps: McpToolDeps): void {
  const service = () => required(deps);
  const roots = { store: deps.store, bootCwd: deps.cwd };
  const catalogRoot =
    (writable: boolean) =>
    async (wire: string | undefined): Promise<string> => {
      if (wire === undefined) return defaultAgentProjectRoot(deps.cwd);
      const resolve = writable ? resolveWritableCatalogRoot : resolveCatalogStartInput;
      const { wireRoot } = await resolve(roots, wire);
      return wireRoot.path;
    };
  const readRoot = catalogRoot(false);
  const writeRoot = catalogRoot(true);

  server.registerTool(
    "get_function",
    {
      description:
        "List functions without id; with id get one function; view revisions or revision reads stored revisions.",
      inputSchema: getFunctionFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getFunctionFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const project = await readRoot(value.project_root);
        if (value.id === undefined) {
          return call(async () => ({ functions: await service().list(project) }));
        }
        const view = value.view ?? "definition";
        switch (view) {
          case "definition":
            return call(async () => service().get(project, value.id!));
          case "revisions":
            return call(async () => ({ revisions: await service().listRevisions(project, value.id!) }));
          case "revision":
            return call(async () => service().getRevision(project, value.id!, value.revision!));
        }
      } catch (error) {
        if (error instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(error), true);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "save_function",
    {
      description:
        "Create or update a function. mode create duplicates with copy_from and id, or creates from definition. mode update needs baseRevision.",
      inputSchema: saveFunctionFlatSchema,
    },
    async (args) => {
      const parsed = saveFunctionFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      try {
        const project = await writeRoot(value.project_root);
        const target = await targetForPath(deps, project);
        if (value.mode === "create") {
          if (value.copy_from !== undefined) {
            return call(async () =>
              withProject(
                await service().duplicate(
                  project,
                  value.copy_from!,
                  { id: value.id!, ...(value.format ? { format: value.format } : {}) },
                  MCP_ACTOR,
                ),
                target,
                { console_url: consoleUrl(deps, `/functions/${encodeURIComponent(value.id!)}`) },
              ),
            );
          }
          return call(async () => {
            const created = await service().create(
              project,
              value.definition!,
              MCP_ACTOR,
              value.format ? { format: value.format } : {},
            );
            const id = (value.definition as { id?: unknown } | undefined)?.id;
            return withProject(
              created,
              target,
              typeof id === "string" ? { console_url: consoleUrl(deps, `/functions/${encodeURIComponent(id)}`) } : {},
            );
          });
        }
        return call(async () =>
          withProject(
            await service().save(
              project,
              value.id!,
              { baseRevision: value.baseRevision!, definition: value.definition!, summary: value.summary ?? null },
              MCP_ACTOR,
            ),
            target,
            { console_url: consoleUrl(deps, `/functions/${encodeURIComponent(value.id!)}`) },
          ),
        );
      } catch (error) {
        if (error instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(error), true);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "test_function",
    {
      description:
        "Test a function with the production executor. real is required for real files, environment, or APIs. A guest failure is isError false with ok false and a diagnostic code.",
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
        project_root: projectRootField,
      }),
    },
    async ({ id, source, input, real, mocks, timeoutMs, memoryLimitBytes, project_root }) => {
      try {
        const project = await writeRoot(project_root);
        return call(async () =>
          invoker(deps).test(project, id!, {
          ...(source !== undefined ? { source } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(real !== undefined ? { real } : {}),
          ...(mocks !== undefined ? { mocks } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(error), true);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "delete_function",
    {
      description: "Delete a function that no pipeline, stage, or agent references.",
      inputSchema: z.object({ id: functionId, project_root: projectRootField }),
    },
    async ({ id, project_root }) => {
      try {
        return call(async () => service().delete(await writeRoot(project_root), id!));
      } catch (error) {
        if (error instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(error), true);
        }
        throw error;
      }
    },
  );
}