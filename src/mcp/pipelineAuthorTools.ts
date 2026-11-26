import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CatalogPathError,
  catalogPathErrorBody,
} from "../config/catalogRelativePath.js";
import { createStage, parseCreateStageBody } from "../config/createStage.js";
import { createTask, parseCreateTaskBody } from "../config/createTask.js";
import type { DraftFileHashes } from "../config/draftPackage.js";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { parseUpdateTaskBody, updateTask } from "../config/updateTask.js";
import { writeCatalogFileForHttp } from "../server/readCatalogFile.js";
import {
  readPipelineFlatSchema,
  writePipelineFlatSchema,
  writeStageFlatSchema,
  writeTaskFlatSchema,
} from "../toolkit/catalogToolModes.js";
import { loadDraftPackage, publishDraftPackageFacade, validateDraftPackage, type DraftPackage } from "./pipelineAuthorSupport.js";
import {
  buildCreatePipelineDraft,
  buildCreateStageDraft,
  buildCreateTaskDraft,
  buildEditPipelineDraft,
  buildEditStageDraft,
  buildEditTaskDraft,
} from "../operatorAgent/profiles/workshopAuthorTools.js";
import { runReadPipelineDag } from "./validateMcpKinds.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import {
  catching,
  pipelineConsoleUrl,
  projectFields,
  resolveReadRoot,
  resolveWriteTarget,
} from "./writeTarget.js";

type Built = { ok: true; nextDraft: DraftPackage } | { ok: false; error: string };

const record = z.record(z.string(), z.unknown());

const guarded =
  (handler: (args: unknown) => Promise<ReturnType<typeof textResult>>) =>
  (args: unknown) =>
    catching(() => handler(args));

/**
 * Author pipelines and tasks straight on disk. Each mutation loads the package,
 * applies the same builder the Workshop uses, and writes it back through the
 * Workshop's publish path (validate first, nothing written when invalid).
 */
export function registerPipelineAuthorTools(server: McpServer, deps: McpToolDeps): void {

  async function mutate(
    relPath: string,
    mode: "create" | "overwrite",
    build: (draft: DraftPackage) => Built,
    options: { taskPath?: string; allowInvalid?: boolean; projectRoot?: string } = {},
  ) {
    const target = await resolveWriteTarget(deps, options.projectRoot);
    const projectRoot = target.path;
    let draft: DraftPackage = { pipeline: { id: "", stages: [] } };
    let baseHashes: DraftFileHashes | undefined;
    if (mode === "overwrite") {
      const loaded = await loadDraftPackage(projectRoot, relPath, options.taskPath ? { taskPath: options.taskPath } : {});
      if (!loaded.ok) return textResult({ error: loaded.error, status: loaded.status }, true);
      draft = loaded.draft;
      baseHashes = loaded.fileHashes;
    }
    const built = build(draft);
    if (!built.ok) return textResult({ error: built.error }, true);
    const directory = path.posix.dirname(relPath.replace(/\\/g, "/")) || ".";
    const published = await publishDraftPackageFacade(projectRoot, {
      directory,
      draft: built.nextDraft,
      pipelineFilename: path.posix.basename(relPath),
      ...(options.allowInvalid ? { allowInvalid: true } : {}),
      ...(baseHashes !== undefined ? { baseHashes } : {}),
    }, mode);
    if (!published.ok) {
      return textResult(
        {
          error: published.error,
          status: published.status,
          ...(published.code ? { code: published.code } : {}),
          ...(published.fileHashes ? { fileHashes: published.fileHashes } : {}),
        },
        true,
      );
    }
    const pipelineId = built.nextDraft.pipeline.id;
    return textResult({
      pipelinePath: published.pipelinePath,
      stagePaths: published.stagePaths,
      taskPath: published.taskPath ?? null,
      fileHashes: published.fileHashes,
      ...projectFields(target),
      ...(typeof pipelineId === "string" && pipelineId !== ""
        ? { console_url: pipelineConsoleUrl(deps, pipelineId, target.project_root) }
        : {}),
    });
  }

  server.registerTool(
    "read_pipeline",
    {
      description:
        "Read a pipeline package (view package) or its stage DAG (view dag).",
      inputSchema: readPipelineFlatSchema,
    },
    guarded(async (args: unknown) => {
      const parsed = readPipelineFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const { path: relPath, view, task_path, project_root } = parsed.data;
      if (view === "dag") {
        return runReadPipelineDag(deps, relPath, project_root);
      }
      const readRoot = await resolveReadRoot(deps, project_root);
      const loaded = await loadDraftPackage(readRoot, relPath, task_path ? { taskPath: task_path } : {});
      if (!loaded.ok) return textResult({ error: loaded.error, status: loaded.status }, true);
      const validation = await validateDraftPackage(loaded.draft, { cwd: deps.cwd, projectRoot: readRoot });
      return textResult({
        draft: loaded.draft,
        destination: loaded.destination,
        validation,
        fileHashes: loaded.fileHashes,
        has_include: loaded.hasInclude,
      });
    }),
  );

  server.registerTool(
    "write_pipeline",
    {
      description: "Create or update a pipeline package on disk. mode create writes a new package; mode update patches with patch.",
      inputSchema: writePipelineFlatSchema,
    },
    guarded(async (args: unknown) => {
      const parsed = writePipelineFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const value = parsed.data;
      if (value.mode === "create") {
        const folder = (value.directory ?? path.posix.dirname((value.path ?? "").replace(/\\/g, "/"))).replace(
          /[\\/]+$/,
          "",
        );
        const id = value.id ?? "";
        const file = `${id}.pipeline.yaml`;
        const relPath = folder === "" || folder === "." ? file : `${folder}/${file}`;
        const createArgs = {
          id,
          ...(value.model !== undefined ? { model: value.model } : {}),
          ...(value.agent !== undefined ? { agent: value.agent } : {}),
          ...(value.stages !== undefined ? { stages: value.stages } : {}),
          ...(value.pipeline !== undefined ? { pipeline: value.pipeline } : {}),
        };
        return mutate(
          relPath,
          "create",
          (draft) => buildCreatePipelineDraft(draft, createArgs),
          { allowInvalid: value.allow_invalid, projectRoot: value.project_root },
        );
      }
      return mutate(
        value.path!,
        "overwrite",
        (draft) => buildEditPipelineDraft(draft, { patch: value.patch! }),
        { allowInvalid: value.allow_invalid, projectRoot: value.project_root },
      );
    }),
  );

  server.registerTool(
    "write_stage",
    {
      description:
        "Create or update stages on disk. With a pipeline path, create adds a stage; update patches a stage. Without a pipeline path, create makes a standalone stage file; update with content overwrites a stage file.",
      inputSchema: writeStageFlatSchema,
    },
    guarded(async (args: unknown) => {
      const parsed = writeStageFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const value = parsed.data;
      if (value.pipeline_directory !== undefined) {
        const body = {
          pipeline_directory: value.pipeline_directory,
          filename: value.filename!,
          id: value.id!,
          system_prompt: value.system_prompt!,
          ...(value.model !== undefined ? { model: value.model } : {}),
          ...(value.gate_kinds !== undefined ? { gate_kinds: value.gate_kinds } : {}),
          ...(value.skill !== undefined ? { skill: value.skill } : {}),
        };
        const stageParsed = parseCreateStageBody(body);
        if ("ok" in stageParsed) {
          return textResult({ error: stageParsed.error, status: stageParsed.status }, true);
        }
        const stageTarget = await resolveWriteTarget(deps, value.project_root);
        const result = await createStage(stageTarget.path, stageParsed);
        if (!result.ok) {
          return textResult(
            {
              error: result.error,
              status: result.status,
              ...(result.status === 409 ? { code: "stage_EXISTS" } : {}),
            },
            true,
          );
        }
        return textResult({ ...result.stage, ...projectFields(stageTarget) });
      }
      if (value.content !== undefined) {
        const relPath = value.path!.trim();
        const fileTarget = await resolveWriteTarget(deps, value.project_root);
        const rootDir = fileTarget.path;
        const roots: CatalogRoot[] = [
          { project_root: rootDir, path: rootDir, kind: "registered", read_only: false },
        ];
        try {
          const result = await writeCatalogFileForHttp({
            inputPath: relPath,
            content: value.content,
            projectRoot: rootDir,
            roots,
            fieldName: "path",
          });
          if (!result.ok) {
            return textResult(
              {
                error: result.error,
                status: result.status,
                ...(result.code !== undefined ? { code: result.code } : {}),
                ...(result.findings !== undefined ? { findings: result.findings } : {}),
              },
              true,
            );
          }
          return textResult({ path: result.path, content: result.content, ...projectFields(fileTarget) });
        } catch (err) {
          if (err instanceof CatalogPathError) {
            return textResult(
              {
                ...catalogPathErrorBody(err),
                status: err.code === "catalog_root_read_only" ? 403 : 400,
              },
              true,
            );
          }
          throw err;
        }
      }
      const stageArgs = {
        path: value.path!,
        id: value.id,
        summary: value.summary,
        system_prompt: value.system_prompt,
        model: value.model,
        entry: value.entry,
        route: value.route,
        io: value.io,
        body: value.body,
        patch: value.patch,
        pipeline_entry: value.pipeline_entry,
        uses: value.uses,
      };
      if (value.mode === "create") {
        return mutate(
          value.path!,
          "overwrite",
          (draft) => buildCreateStageDraft(draft, stageArgs),
          { allowInvalid: value.allow_invalid, projectRoot: value.project_root },
        );
      }
      return mutate(
        value.path!,
        "overwrite",
        (draft) => {
          const built = buildEditStageDraft(draft, stageArgs);
          return built;
        },
        { allowInvalid: value.allow_invalid, projectRoot: value.project_root },
      );
    }),
  );

  server.registerTool(
    "write_task",
    {
      description: "Create or update task files on disk, beside a pipeline or as a standalone catalog task.",
      inputSchema: writeTaskFlatSchema,
    },
    guarded(async (args: unknown) => {
      const parsed = writeTaskFlatSchema.safeParse(args);
      if (!parsed.success) {
        return textResult(
          { error: parsed.error.issues[0]?.message ?? "Invalid arguments", status: 400 },
          true,
        );
      }
      const value = parsed.data;
      if (value.path === undefined) {
        if (value.mode === "create") {
          const body = {
            directory: value.directory!,
            id: value.id!,
            goal: value.goal!,
            ...(value.context !== undefined ? { context: value.context } : {}),
            ...(value.constraints !== undefined ? { constraints: value.constraints } : {}),
            ...(value.checkout !== undefined ? { checkout: value.checkout } : {}),
            ...(value.repository !== undefined ? { repository: value.repository } : {}),
            ...(value.ref !== undefined ? { ref: value.ref } : {}),
          };
          const taskParsed = parseCreateTaskBody(body);
          if ("ok" in taskParsed) {
            return textResult({ error: taskParsed.error, status: taskParsed.status }, true);
          }
          const taskTarget = await resolveWriteTarget(deps, value.project_root);
          const result = await createTask(taskTarget.path, taskParsed);
          if (!result.ok) return textResult({ error: result.error, status: result.status }, true);
          return textResult({ task: result.task, ...projectFields(taskTarget) });
        }
        const updateBody = {
          goal: value.goal!,
          ...(value.context !== undefined ? { context: value.context } : {}),
          ...(value.constraints !== undefined ? { constraints: value.constraints } : {}),
          ...(value.checkout !== undefined ? { checkout: value.checkout } : {}),
          ...(value.repository !== undefined ? { repository: value.repository } : {}),
          ...(value.ref !== undefined ? { ref: value.ref } : {}),
        };
        const taskParsed = parseUpdateTaskBody(updateBody);
        if ("ok" in taskParsed) {
          return textResult({ error: taskParsed.error, status: taskParsed.status }, true);
        }
        const updateTarget = await resolveWriteTarget(deps, value.project_root);
        const result = await updateTask({
          store: deps.store,
          bootCwd: deps.cwd,
          taskId: value.id!,
          input: taskParsed,
          projectRootFilter: updateTarget.path,
        });
        if (!result.ok) return textResult({ error: result.error, status: result.status }, true);
        return textResult({ task: result.task, ...projectFields(updateTarget) });
      }
      const taskArgs = {
        id: value.id,
        goal: value.goal,
        filename: value.filename,
        body: value.body,
        patch: value.patch,
      };
      if (value.mode === "create") {
        return mutate(value.path, "overwrite", (draft) => buildCreateTaskDraft(draft, taskArgs), {
          allowInvalid: value.allow_invalid,
          projectRoot: value.project_root,
        });
      }
      return mutate(
        value.path,
        "overwrite",
        (draft) => buildEditTaskDraft(draft, taskArgs),
        {
          taskPath: value.task_path!,
          allowInvalid: value.allow_invalid,
          projectRoot: value.project_root,
        },
      );
    }),
  );

}
