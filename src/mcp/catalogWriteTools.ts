import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CatalogPathError,
  catalogPathErrorBody,
} from "../config/catalogRelativePath.js";
import { createStage, parseCreateStageBody } from "../config/createStage.js";
import { createTask, parseCreateTaskBody } from "../config/createTask.js";
import { parseDraftPackageBody, validateDraftPackage } from "../config/draftPackage.js";
import {
  importTaskFromIssue,
  parseImportTaskBody,
  type IssueFetch,
} from "../config/importTask.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { parseUpdateTaskBody, updateTask } from "../config/updateTask.js";
import { writeCatalogFileForHttp } from "../server/readCatalogFile.js";
import { STAGE_GATE_KINDS } from "../types/stage.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

type CatalogWriteDeps = McpToolDeps & {
  issueFetch?: IssueFetch;
};

const projectRootField = z
  .string()
  .optional()
  .describe(
    "Catalog project root. When omitted, the server project root is used, then the process cwd.",
  );

const record = z.record(z.string(), z.unknown());

const draftPipelineSchema = z.object({
  id: z.string(),
  stages: z.array(record),
  agent: z.unknown().optional(),
  model: z.unknown().optional(),
  schemas: z.unknown().optional(),
  requires: z.unknown().optional(),
  channels: z.unknown().optional(),
  memories: z.unknown().optional(),
});

const draftStageSchema = z.object({
  path: z.string(),
  body: record,
});

const draftTaskSchema = z.object({
  filename: z.string(),
  body: record,
});

const optionalTaskString = z
  .string()
  .nullable()
  .optional()
  .describe("String value, or null or empty string to remove the field");

function rejected(result: {
  error: string;
  status: number;
  code?: string;
  findings?: unknown;
  project_roots?: string[];
  registered_roots?: string[];
  hint?: string;
}) {
  return textResult(
    {
      error: result.error,
      status: result.status,
      ...(result.code !== undefined ? { code: result.code } : {}),
      ...(result.findings !== undefined ? { findings: result.findings } : {}),
      ...(result.project_roots !== undefined ? { project_roots: result.project_roots } : {}),
      ...(result.registered_roots !== undefined ? { registered_roots: result.registered_roots } : {}),
      ...(result.hint !== undefined ? { hint: result.hint } : {}),
    },
    true,
  );
}

async function projectRootOf(
  deps: CatalogWriteDeps,
  projectRoot: string | undefined,
): Promise<string> {
  const resolved = path.resolve(projectRoot ?? deps.projectRoot ?? deps.cwd);
  return realpath(resolved).catch(() => resolved);
}

export function registerCatalogWriteTools(server: McpServer, deps: CatalogWriteDeps): void {
  server.registerTool(
    "create_task_file",
    {
      description:
        "Create a standalone catalog task file (POST /api/tasks). The task is not attached to a pipeline; use create_task to add one beside a pipeline package.",
      inputSchema: z.object({
        project_root: projectRootField,
        directory: z.string().describe("Directory relative to the project root, e.g. tasks"),
        id: z.string().describe("Lowercase kebab-case task id, 1-64 characters"),
        goal: z.string(),
        context: z.string().optional(),
        constraints: z.string().optional(),
        checkout: z.string().optional(),
        repository: z.string().optional(),
        ref: z.string().optional(),
      }),
    },
    async ({ project_root, ...body }) => {
      const parsed = parseCreateTaskBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const result = await createTask(await projectRootOf(deps, project_root), parsed);
      if (!result.ok) return rejected(result);
      return textResult({ task: result.task });
    },
  );

  server.registerTool(
    "update_task_file",
    {
      description:
        "Update a standalone catalog task by id (PUT /api/tasks/:id). goal is required. Pass null or an empty string for context, constraints, checkout, repository, or ref to remove that field.",
      inputSchema: z.object({
        project_root: projectRootField,
        id: z.string().describe("Task id"),
        goal: z.string(),
        context: optionalTaskString,
        constraints: optionalTaskString,
        checkout: optionalTaskString,
        repository: optionalTaskString,
        ref: optionalTaskString,
      }),
    },
    async ({ project_root, id, ...body }) => {
      const parsed = parseUpdateTaskBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const result = await updateTask({
        store: deps.store,
        bootCwd: deps.cwd,
        taskId: id,
        input: parsed,
        projectRootFilter: await projectRootOf(deps, project_root),
      });
      if (!result.ok) return rejected(result);
      return textResult({ task: result.task });
    },
  );

  server.registerTool(
    "import_task_file",
    {
      description:
        "Import a GitHub issue as a standalone catalog task file (POST /api/tasks/import). The issue title becomes the goal and the task id.",
      inputSchema: z.object({
        project_root: projectRootField,
        repo: z.string().describe("GitHub owner/repo"),
        number: z.number().describe("Positive GitHub issue number"),
        directory: z.string().describe("Directory relative to the project root, e.g. tasks"),
      }),
    },
    async ({ project_root, ...body }) => {
      const parsed = parseImportTaskBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const result = await importTaskFromIssue(
        await projectRootOf(deps, project_root),
        parsed,
        deps.issueFetch,
      );
      if (!result.ok) return rejected(result);
      return textResult({ task: result.task });
    },
  );

  server.registerTool(
    "create_stage_file",
    {
      description:
        "Create an orphan stage YAML file that is not wired into a pipeline (POST /api/stages). Use create_stage to add a stage to a pipeline package.",
      inputSchema: z.object({
        project_root: projectRootField,
        pipeline_directory: z.string().describe("Directory relative to the project root"),
        filename: z.string().describe("Stage filename ending in .yaml or .yml"),
        id: z.string().describe("Lowercase kebab-case stage id, 1-64 characters"),
        system_prompt: z.string(),
        model: z.string().optional(),
        gate_kinds: z
          .array(z.string())
          .optional()
          .describe(`Stage gate kinds. Each entry must be one of: ${STAGE_GATE_KINDS.join(", ")}`),
        skill: z.string().optional(),
      }),
    },
    async ({ project_root, ...body }) => {
      const parsed = parseCreateStageBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const result = await createStage(await projectRootOf(deps, project_root), parsed);
      if (!result.ok) return rejected(result);
      return textResult(result.stage);
    },
  );

  server.registerTool(
    "write_catalog_file",
    {
      description:
        "Overwrite an existing stage catalog file (PUT /api/catalog/file). The file must already exist and remain valid stage YAML; an invalid write is restored.",
      inputSchema: z.object({
        project_root: projectRootField,
        path: z.string().describe("Catalog-relative .yaml or .yml path"),
        content: z.string().describe("Full stage YAML contents"),
      }),
    },
    async ({ project_root, path: relPath, content }) => {
      if (typeof relPath !== "string" || relPath.trim().length === 0) {
        return rejected({ error: "path is required", status: 400 });
      }
      if (typeof content !== "string") {
        return rejected({ error: "content must be a string", status: 400 });
      }
      const root = await projectRootOf(deps, project_root);
      const roots: CatalogRoot[] = [
        {
          project_root: root,
          path: root,
          kind: "registered",
          read_only: false,
        },
      ];
      try {
        const result = await writeCatalogFileForHttp({
          inputPath: relPath.trim(),
          content,
          projectRoot: root,
          roots,
          fieldName: "path",
        });
        if (!result.ok) return rejected(result);
        return textResult({ path: result.path, content: result.content });
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return rejected({
            ...catalogPathErrorBody(err),
            status: err.code === "catalog_root_read_only" ? 403 : 400,
          });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "validate_catalog_draft",
    {
      description:
        "Validate an in-memory pipeline draft package (POST /api/drafts/validate). Nothing is written. Pass the package as draft, or as top-level pipeline, stages, and task.",
      inputSchema: z.union([
        z.object({
          project_root: projectRootField,
          draft: z
            .object({
              pipeline: draftPipelineSchema,
              stages: z.array(draftStageSchema).optional(),
              task: draftTaskSchema.optional(),
            })
            .describe("Draft package."),
        }),
        z.object({
          project_root: projectRootField,
          pipeline: draftPipelineSchema,
          stages: z.array(draftStageSchema).optional(),
          task: draftTaskSchema.optional(),
        }),
      ]),
      annotations: { readOnlyHint: true },
    },
    async (body) => {
      const parsed = parseDraftPackageBody(body);
      if ("ok" in parsed) return rejected(parsed);
      const root = await projectRootOf(deps, body.project_root);
      const result = await validateDraftPackage(parsed, {
        cwd: root,
        projectRoot: root,
        strict: true,
      });
      return textResult(result);
    },
  );
}
