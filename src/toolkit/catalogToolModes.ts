import { z } from "zod";
import type { ModeResolver } from "./modes.js";
import { isResolverResult, ok, parseOrReject } from "./modeResolverHelpers.js";
import { inlinePipelineSchema } from "./runToolModes.js";

const record = z.record(z.string(), z.unknown());

export const listCatalogFlatSchema = z
  .object({
    kind: z.enum(["pipelines", "tasks", "skills", "models", "mcp_servers", "providers", "health"]),
    project_root: z.string().optional(),
    runId: z.string().optional(),
  })
  .strict();

export const readPipelineFlatSchema = z
  .object({
    path: z.string().min(1),
    view: z.enum(["package", "dag"]).optional(),
    task_path: z.string().optional(),
    project_root: z.string().optional(),
  })
  .strict();

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

export const validateFlatSchema = z
  .object({
    kind: z.enum(["catalog", "pipeline", "task", "draft", "agent", "eval", "connection_recipient"]),
    preflight: z.boolean().optional(),
    strict: z.boolean().optional(),
    project_root: z.string().optional(),
    pipeline: z.union([z.string(), inlinePipelineSchema]).optional(),
    task: z.string().optional(),
    draft: z
      .object({
        pipeline: draftPipelineSchema,
        stages: z.array(draftStageSchema).optional(),
        task: draftTaskSchema.optional(),
      })
      .optional(),
    package_pipeline: draftPipelineSchema.optional(),
    stages: z.array(draftStageSchema).optional(),
    task_draft: draftTaskSchema.optional(),
    definition: record.optional(),
    eval_id: z.string().optional(),
    yaml: z.string().optional(),
    path: z.string().optional(),
    dataset_cases: z.array(record).optional(),
    id: z.string().optional(),
    to: z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()])).min(1)]).optional(),
    cc: z.array(z.union([z.string(), z.number().int()])).min(1).optional(),
    template: record.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.preflight === true) {
      if (value.pipeline === undefined) {
        ctx.addIssue({ code: "custom", message: "pipeline is required when preflight is true" });
      }
      if (value.kind !== "pipeline") {
        ctx.addIssue({ code: "custom", message: "kind must be pipeline when preflight is true" });
      }
      return;
    }
    switch (value.kind) {
      case "catalog":
        return;
      case "pipeline":
        if (value.pipeline === undefined || (typeof value.pipeline === "string" && !value.pipeline.trim())) {
          ctx.addIssue({ code: "custom", message: "pipeline is required when kind is pipeline" });
        }
        return;
      case "task":
        if (value.task === undefined || !value.task.trim()) {
          ctx.addIssue({ code: "custom", message: "task is required when kind is task" });
        }
        return;
      case "draft": {
        const hasDraft = value.draft !== undefined;
        const hasTop = value.package_pipeline !== undefined;
        if (hasDraft === hasTop) {
          ctx.addIssue({
            code: "custom",
            message: hasDraft
              ? "Use either draft or top-level package_pipeline, not both"
              : "draft package fields are required when kind is draft",
          });
        }
        return;
      }
      case "agent":
        if (value.definition === undefined) {
          ctx.addIssue({ code: "custom", message: "definition is required when kind is agent" });
        }
        return;
      case "eval":
        if ((value.eval_id === undefined) === (value.yaml === undefined)) {
          ctx.addIssue({ code: "custom", message: "Provide exactly one of eval_id or yaml when kind is eval" });
        }
        return;
      case "connection_recipient":
        if (value.id === undefined || !value.id.trim()) {
          ctx.addIssue({ code: "custom", message: "id is required when kind is connection_recipient" });
        }
        if (value.to === undefined) {
          ctx.addIssue({ code: "custom", message: "to is required when kind is connection_recipient" });
        }
    }
  });

export const writePipelineFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    path: z.string().optional(),
    directory: z.string().optional(),
    id: z.string().optional(),
    model: z.string().optional(),
    agent: z.unknown().optional(),
    stages: z.array(record).optional(),
    pipeline: record.optional(),
    patch: record.optional(),
    allow_invalid: z.boolean().optional(),
    project_root: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "create") {
      if (value.directory === undefined && value.path === undefined) {
        ctx.addIssue({ code: "custom", message: "directory or path is required for mode create" });
      }
      return;
    }
    if (value.path === undefined || !value.path.trim()) {
      ctx.addIssue({ code: "custom", message: "path is required for mode update" });
    }
    if (value.patch === undefined) {
      ctx.addIssue({ code: "custom", message: "patch is required for mode update" });
    }
  });

export const writeStageFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    path: z.string().optional(),
    project_root: z.string().optional(),
    allow_invalid: z.boolean().optional(),
    id: z.string().optional(),
    summary: z.string().optional(),
    system_prompt: z.string().optional(),
    model: z.string().optional(),
    entry: z.boolean().optional(),
    route: z.array(record).optional(),
    io: record.optional(),
    body: record.optional(),
    patch: record.optional(),
    pipeline_entry: record.optional(),
    uses: z.string().optional(),
    pipeline_directory: z.string().optional(),
    filename: z.string().optional(),
    gate_kinds: z.array(z.string()).optional(),
    skill: z.string().optional(),
    content: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPatch =
      value.patch !== undefined ||
      value.pipeline_entry !== undefined ||
      value.body !== undefined ||
      value.entry !== undefined ||
      value.route !== undefined ||
      value.uses !== undefined ||
      value.io !== undefined;
    const hasContent = value.content !== undefined;
    if (hasPatch && hasContent) {
      ctx.addIssue({ code: "custom", message: "Use only one of patch-style fields or content, not both" });
      return;
    }
    const standaloneCreate = value.pipeline_directory !== undefined;
    if (value.mode === "create") {
      if (standaloneCreate) {
        if (!value.pipeline_directory?.trim()) {
          ctx.addIssue({ code: "custom", message: "pipeline_directory is required for a standalone stage create" });
        }
        if (!value.filename?.trim()) {
          ctx.addIssue({ code: "custom", message: "filename is required for a standalone stage create" });
        }
        if (!value.system_prompt?.trim()) {
          ctx.addIssue({ code: "custom", message: "system_prompt is required for a standalone stage create" });
        }
        return;
      }
      if (!value.path?.trim()) {
        ctx.addIssue({ code: "custom", message: "path is required when creating a pipeline-backed stage" });
      }
      return;
    }
    if (hasContent) {
      if (!value.path?.trim()) {
        ctx.addIssue({ code: "custom", message: "path is required when content is set" });
      }
      return;
    }
    if (!value.path?.trim()) {
      ctx.addIssue({ code: "custom", message: "path is required for mode update" });
      return;
    }
    if (!value.id?.trim()) {
      ctx.addIssue({ code: "custom", message: "id is required for a pipeline stage update" });
    }
  });

export const writeTaskFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    path: z.string().optional(),
    task_path: z.string().optional(),
    project_root: z.string().optional(),
    allow_invalid: z.boolean().optional(),
    id: z.string().optional(),
    goal: z.string().optional(),
    filename: z.string().optional(),
    body: record.optional(),
    patch: record.optional(),
    context: z.string().nullable().optional(),
    constraints: z.string().nullable().optional(),
    checkout: z.string().nullable().optional(),
    repository: z.string().nullable().optional(),
    ref: z.string().nullable().optional(),
    directory: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const standalone = value.path === undefined;
    if (value.mode === "create") {
      if (standalone) {
        if (value.directory === undefined || !value.directory.trim()) {
          ctx.addIssue({ code: "custom", message: "directory is required for a standalone task create" });
        }
        if (value.id === undefined || !value.id.trim()) {
          ctx.addIssue({ code: "custom", message: "id is required for a standalone task create" });
        }
        if (value.goal === undefined || !value.goal.trim()) {
          ctx.addIssue({ code: "custom", message: "goal is required for a standalone task create" });
        }
      } else if (value.path === undefined || !value.path.trim()) {
        ctx.addIssue({ code: "custom", message: "path is required for a pipeline task create" });
      }
      return;
    }
    if (standalone) {
      if (value.id === undefined || !value.id.trim()) {
        ctx.addIssue({ code: "custom", message: "id is required for a standalone task update" });
      }
      if (value.goal === undefined || !value.goal.trim()) {
        ctx.addIssue({ code: "custom", message: "goal is required for a standalone task update" });
      }
      return;
    }
    if (value.path === undefined || !value.path.trim()) {
      ctx.addIssue({ code: "custom", message: "path is required for a pipeline task update" });
    }
    if (value.task_path === undefined || !value.task_path.trim()) {
      ctx.addIssue({ code: "custom", message: "task_path is required for a pipeline task update" });
    }
  });

export const resolveListCatalogMode: ModeResolver = (args) => {
  const data = parseOrReject(listCatalogFlatSchema, args, "list_catalog");
  if (isResolverResult(data)) return data;
  return ok(data.kind);
};

export const resolveValidateMode: ModeResolver = (args) => {
  const data = parseOrReject(validateFlatSchema, args, "validate");
  if (isResolverResult(data)) return data;
  if (data.preflight === true) return ok("preflight");
  return ok(data.kind);
};

export const resolveReadPipelineMode: ModeResolver = (args) => {
  const data = parseOrReject(readPipelineFlatSchema, args, "read_pipeline");
  if (!("path" in data)) return data;
  return ok(data.view === "dag" ? "dag" : "package", data.path);
};

export const resolveWritePipelineMode: ModeResolver = (args) => {
  const data = parseOrReject(writePipelineFlatSchema, args, "write_pipeline");
  if (!("mode" in data)) return data;
  return ok(data.mode, typeof data.path === "string" ? data.path : typeof data.id === "string" ? data.id : undefined);
};

export const resolveWriteStageMode: ModeResolver = (args) => {
  const data = parseOrReject(writeStageFlatSchema, args, "write_stage");
  if (!("mode" in data)) return data;
  if (data.mode === "create") {
    if (data.pipeline_directory !== undefined) return ok("standalone_create", data.id);
    return ok("pipeline_create", data.id);
  }
  if (data.content !== undefined) return ok("standalone_content", data.path);
  return ok("pipeline_patch", data.id);
};

export const resolveWriteTaskMode: ModeResolver = (args) => {
  const data = parseOrReject(writeTaskFlatSchema, args, "write_task");
  if (!("mode" in data)) return data;
  const standalone = data.path === undefined;
  if (data.mode === "create") return ok(standalone ? "standalone_create" : "pipeline_create", data.id);
  return ok(standalone ? "standalone_update" : "pipeline_update", data.id ?? data.task_path);
};

export const CATALOG_TOOL_MODE_RESOLVERS: Readonly<Record<string, ModeResolver>> = {
  list_catalog: resolveListCatalogMode,
  validate: resolveValidateMode,
  read_pipeline: resolveReadPipelineMode,
  write_pipeline: resolveWritePipelineMode,
  write_stage: resolveWriteStageMode,
  write_task: resolveWriteTaskMode,
};