import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadDraftPackage, publishDraftPackageFacade, validateDraftPackage, type DraftPackage } from "./pipelineAuthorSupport.js";
import {
  buildCreatePipelineDraft,
  buildCreateStageDraft,
  buildCreateTaskDraft,
  buildEditPipelineDraft,
  buildEditStageDraft,
  buildEditTaskDraft,
} from "../operatorAgent/profiles/workshopAuthorTools.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

type Built = { ok: true; nextDraft: DraftPackage } | { ok: false; error: string };

const pipelinePath = z
  .string()
  .describe("Pipeline YAML path relative to the project root, e.g. workshop/release/pipeline.yaml");
const record = z.record(z.string(), z.unknown());
const allowInvalid = z
  .boolean()
  .optional()
  .describe("Write even when validation fails, so a pipeline can be built up step by step. Default false.");

/**
 * Author pipelines and tasks straight on disk. Each mutation loads the package,
 * applies the same builder the Workshop uses, and writes it back through the
 * Workshop's publish path (validate first, nothing written when invalid).
 */
export function registerPipelineAuthorTools(server: McpServer, deps: McpToolDeps): void {
  const root = () => deps.projectRoot ?? deps.cwd;

  async function mutate(
    relPath: string,
    mode: "create" | "overwrite",
    build: (draft: DraftPackage) => Built,
    options: { taskPath?: string; allowInvalid?: boolean } = {},
  ) {
    const projectRoot = root();
    let draft: DraftPackage = { pipeline: { id: "", stages: [] } };
    if (mode === "overwrite") {
      const loaded = await loadDraftPackage(projectRoot, relPath, options.taskPath ? { taskPath: options.taskPath } : {});
      if (!loaded.ok) return textResult({ error: loaded.error, status: loaded.status }, true);
      draft = loaded.draft;
    }
    const built = build(draft);
    if (!built.ok) return textResult({ error: built.error }, true);
    const directory = path.posix.dirname(relPath.replace(/\\/g, "/")) || ".";
    const published = await publishDraftPackageFacade(projectRoot, {
      directory,
      draft: built.nextDraft,
      pipelineFilename: path.posix.basename(relPath),
      ...(options.allowInvalid ? { allowInvalid: true } : {}),
    }, mode);
    if (!published.ok) return textResult({ error: published.error, status: published.status }, true);
    return textResult({ pipelinePath: published.pipelinePath, stagePaths: published.stagePaths, taskPath: published.taskPath ?? null });
  }

  server.registerTool(
    "read_pipeline",
    {
      description: "Read a pipeline package from disk (pipeline, stage files, optional task) with its validation result. Use before editing.",
      inputSchema: z.object({ path: pipelinePath, task_path: z.string().optional().describe("Task file to include, relative to the project root") }),
    },
    async ({ path: relPath, task_path }) => {
      const loaded = await loadDraftPackage(root(), relPath, task_path ? { taskPath: task_path } : {});
      if (!loaded.ok) return textResult({ error: loaded.error, status: loaded.status }, true);
      const validation = await validateDraftPackage(loaded.draft, { cwd: deps.cwd, projectRoot: root() });
      return textResult({ draft: loaded.draft, destination: loaded.destination, validation });
    },
  );

  server.registerTool(
    "create_pipeline",
    {
      description: "Create a new pipeline package on disk (id, optional model/stages). Fails if it already exists; use edit_pipeline instead. A pipeline needs at least one stage to validate, so add stages or pass allow_invalid and then create_stage.",
      inputSchema: z.object({
        directory: z.string().describe("Catalog folder relative to the project root, e.g. workshop/release. The file is written as <id>.pipeline.yaml"),
        id: z.string(),
        model: z.string().optional(),
        agent: z.unknown().optional(),
        stages: z.array(record).optional(),
        pipeline: record.optional().describe("Whole pipeline object, instead of id/model/stages"),
        allow_invalid: allowInvalid,
      }),
    },
    ({ directory, allow_invalid, ...args }) => {
      const folder = directory.replace(/[\\/]+$/, "");
      const file = `${typeof args.id === "string" ? args.id : ""}.pipeline.yaml`;
      return mutate(folder === "" || folder === "." ? file : `${folder}/${file}`, "create", (draft) => buildCreatePipelineDraft(draft, args), { allowInvalid: allow_invalid });
    },
  );

  server.registerTool(
    "edit_pipeline",
    {
      description: "Edit pipeline fields on disk (id, model, agent, stages wiring, schemas, requires). Pass the fields to change under patch.",
      inputSchema: z.object({ path: pipelinePath, patch: record, allow_invalid: allowInvalid }),
    },
    ({ path: relPath, patch, allow_invalid }) => mutate(relPath, "overwrite", (draft) => buildEditPipelineDraft(draft, { patch }), { allowInvalid: allow_invalid }),
  );

  server.registerTool(
    "create_stage",
    {
      description: "Add a file-backed stage to a pipeline on disk (uses: ./id.yaml plus the stage body with io).",
      inputSchema: z.object({
        path: pipelinePath,
        id: z.string().optional(),
        summary: z.string().optional(),
        system_prompt: z.string().optional(),
        model: z.string().optional(),
        entry: z.boolean().optional(),
        route: z.array(record).optional(),
        io: record.optional(),
        body: record.optional().describe("Extra stage body fields"),
        allow_invalid: allowInvalid,
      }),
    },
    ({ path: relPath, allow_invalid, ...args }) => mutate(relPath, "overwrite", (draft) => buildCreateStageDraft(draft, args), { allowInvalid: allow_invalid }),
  );

  server.registerTool(
    "edit_stage",
    {
      description: "Edit an existing stage on disk by id: body fields and/or its pipeline entry (route, entry, uses).",
      inputSchema: z.object({
        path: pipelinePath,
        id: z.string(),
        patch: record.optional(),
        body: record.optional(),
        pipeline_entry: record.optional(),
        entry: z.boolean().optional(),
        route: z.array(record).optional(),
        uses: z.string().optional(),
        system_prompt: z.string().optional(),
        model: z.string().optional(),
        io: record.optional(),
        allow_invalid: allowInvalid,
      }),
    },
    ({ path: relPath, allow_invalid, ...args }) => mutate(relPath, "overwrite", (draft) => buildEditStageDraft(draft, args), { allowInvalid: allow_invalid }),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create or replace the task beside a pipeline on disk (id and goal, optional body).",
      inputSchema: z.object({ path: pipelinePath, id: z.string().optional(), goal: z.string().optional(), filename: z.string().optional(), body: record.optional(), allow_invalid: allowInvalid }),
    },
    ({ path: relPath, allow_invalid, ...args }) => mutate(relPath, "overwrite", (draft) => buildCreateTaskDraft(draft, args), { allowInvalid: allow_invalid }),
  );

  server.registerTool(
    "edit_task",
    {
      description: "Edit the task of a pipeline on disk (id, goal, body fields).",
      inputSchema: z.object({
        path: pipelinePath,
        task_path: z.string().describe("Task file relative to the project root"),
        id: z.string().optional(),
        goal: z.string().optional(),
        patch: record.optional(),
        body: record.optional(),
        allow_invalid: allowInvalid,
      }),
    },
    ({ path: relPath, task_path, allow_invalid, ...args }) => mutate(relPath, "overwrite", (draft) => buildEditTaskDraft(draft, args), { taskPath: task_path, allowInvalid: allow_invalid }),
  );
}
