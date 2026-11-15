import { z } from "zod";
import type { ModeResolver } from "./modes.js";
import { ok, reject } from "./modeResolverHelpers.js";

const gitIdentitySchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

export const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z
    .union([
      z.string(),
      z
        .object({
          branch: z.string().optional(),
          base: z.string().optional(),
        })
        .strict(),
    ])
    .optional(),
  repository: z.string().optional(),
  ref: z.string().optional(),
  run_branch_template: z.string().optional(),
  git_identity: gitIdentitySchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const inlinePipelineSchema = z
  .object({
    id: z.string().min(1),
    stages: z.array(z.record(z.string(), z.unknown())).min(1),
    agent: z.unknown().optional(),
    model: z.unknown().optional(),
    schemas: z.unknown().optional(),
    requires: z.unknown().optional(),
    channels: z.unknown().optional(),
  })
  .strict();

const envelopeRefSchema = z.object({
  runId: z.string(),
  stageId: z.string(),
  attempt: z.number().int().positive().optional(),
});

export const envelopeRefField = z.union([envelopeRefSchema, z.array(envelopeRefSchema).min(1)]);

const runStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

const startRunSharedFields = {
  project_root: z.string().optional(),
  checkout: z.string().optional(),
  checkout_override: z.string().optional(),
  skip_gates: z.boolean().optional(),
  git_sha: z.string().optional(),
  ci_pr_url: z.string().optional(),
  ci_job_url: z.string().optional(),
  skills: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  task_path: z.string().optional(),
  task: taskFileSchema.optional(),
  envelope_ref: envelopeRefField.optional(),
  model: z.string().optional(),
  blocking: z.boolean().optional(),
  timeout_ms: z.number().optional(),
};

export const startRunFlatSchema = z
  .object({
    pipeline: z.union([z.string(), inlinePipelineSchema]).optional(),
    stage: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    from_run: z.string().optional(),
    pinned: z.boolean().optional(),
    ...startRunSharedFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    const modes = [
      value.pipeline !== undefined ? "pipeline" : null,
      value.stage !== undefined ? "stage" : null,
      value.from_run !== undefined ? "from_run" : null,
    ].filter(Boolean) as string[];
    if (modes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of pipeline, stage, or from_run is required",
      });
      return;
    }
    if (modes.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: `Use only one start mode; conflicting fields: ${modes.join(", ")}`,
      });
    }
    if (value.pipeline !== undefined && value.task_path !== undefined && value.task !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of task_path or task is required",
      });
    }
  });

export const getRunFlatSchema = z
  .object({
    runId: z.string().min(1).optional(),
    view: z.enum(["export"]).optional(),
    status: runStatusSchema.optional(),
    since: z.string().optional(),
    pipeline: z.string().optional(),
    caller_id: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.runId === undefined && value.view === "export") {
      ctx.addIssue({ code: "custom", message: "runId is required when view is export" });
    }
  });

export const getStageFlatSchema = z
  .object({
    runId: z.string().min(1),
    stageId: z.string().min(1),
    view: z.enum(["events", "log", "envelope", "verification"]),
    attempt: z.number().int().positive().optional(),
    since_offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const runFilesFlatSchema = z
  .object({
    runId: z.string().min(1),
    view: z.enum(["artifact", "changes", "diff", "file"]),
    path: z.string().optional(),
    mode: z.enum(["stat", "patch"]).optional(),
    maxBytes: z.number().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.view === "artifact" || value.view === "file") && (!value.path || !value.path.trim())) {
      ctx.addIssue({ code: "custom", message: "path is required for this view" });
    }
  });

export const stageActionFlatSchema = z
  .object({
    runId: z.string().min(1),
    stageId: z.string().min(1),
    action: z.enum(["retry", "resume", "recover", "stop_recovery"]),
    guidance: z.string().max(4_000).optional(),
  })
  .strict();

export const deleteRunsFlatSchema = z
  .object({
    runId: z.string().min(1).optional(),
    force: z.boolean().optional(),
    gc: z.boolean().optional(),
    execute: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const deleting = value.runId !== undefined;
    const gc = value.gc === true;
    if (deleting === gc) {
      ctx.addIssue({
        code: "custom",
        message: deleting
          ? "gc cannot be true when runId is set"
          : "Exactly one of runId or gc: true is required",
      });
    }
  });

export const listWaitingFlatSchema = z
  .object({
    runId: z.string().optional(),
    path: z.string().optional(),
    detail: z.enum(["full", "summary"]).optional(),
  })
  .strict();

export const resolveStartRunMode: ModeResolver = (args) => {
  const parsed = startRunFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid start_run arguments.");
  }
  const value = parsed.data;
  if (value.from_run !== undefined) return ok("from_run", value.from_run.trim() || undefined);
  if (value.stage !== undefined) return ok("stage");
  return ok("pipeline");
};

export const resolveGetRunMode: ModeResolver = (args) => {
  if (typeof args.runId === "string" && args.runId === "") {
    return reject("runId must not be empty");
  }
  const parsed = getRunFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid get_run arguments.");
  }
  const value = parsed.data;
  if (value.runId === undefined) return ok("list");
  if (value.view === "export") return ok("export", value.runId);
  return ok("single", value.runId);
};

export const resolveGetStageMode: ModeResolver = (args) => {
  const parsed = getStageFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid get_stage arguments.");
  }
  return ok(parsed.data.view, typeof args.runId === "string" ? args.runId : undefined);
};

export const resolveRunFilesMode: ModeResolver = (args) => {
  const parsed = runFilesFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid run_files arguments.");
  }
  return ok(parsed.data.view, typeof args.runId === "string" ? args.runId : undefined);
};

export const resolveStageActionMode: ModeResolver = (args) => {
  const parsed = stageActionFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid stage_action arguments.");
  }
  return ok(parsed.data.action, parsed.data.runId);
};

export const resolveDeleteRunsMode: ModeResolver = (args) => {
  const parsed = deleteRunsFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid delete_runs arguments.");
  }
  if (parsed.data.gc === true) return ok(parsed.data.execute === true ? "gc_execute" : "gc");
  return ok("delete", parsed.data.runId);
};

export const resolveListWaitingMode: ModeResolver = (args) => {
  const parsed = listWaitingFlatSchema.safeParse(args);
  if (!parsed.success) {
    return reject(parsed.error.issues[0]?.message ?? "Invalid list_waiting arguments.");
  }
  return ok(parsed.data.detail === "summary" ? "summary" : "full");
};

export const RUN_TOOL_MODE_RESOLVERS: Readonly<Record<string, ModeResolver>> = {
  start_run: resolveStartRunMode,
  get_run: resolveGetRunMode,
  get_stage: resolveGetStageMode,
  run_files: resolveRunFilesMode,
  stage_action: resolveStageActionMode,
  delete_runs: resolveDeleteRunsMode,
  list_waiting: resolveListWaitingMode,
};