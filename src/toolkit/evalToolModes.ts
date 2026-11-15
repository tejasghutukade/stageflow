import { z } from "zod";
import { EVAL_LIMITS, EVAL_RUN_STATUSES } from "../evals/constants.js";
import { MAX_LIMIT } from "../evals/read/api.js";
import { SUGGESTION_STATUSES, TRIAGE_BUCKETS } from "../evals/triage/constants.js";
import type { ModeResolver } from "./modes.js";
import { isResolverResult, ok, parseOrReject } from "./modeResolverHelpers.js";

const record = z.record(z.string(), z.unknown());
const projectRootField = z.string().optional();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const datasetTargetObject = z
  .object({
    pipeline_path: z.string().optional(),
    stage_id: z.string().optional(),
    file: z.string().optional(),
    agent_id: z.string().optional(),
  })
  .strict();

export const caseOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), case: record }),
  z.strictObject({ op: z.literal("update"), id: z.string(), case: record }),
  z.strictObject({ op: z.literal("delete"), id: z.string() }),
  z.strictObject({ op: z.literal("set_tags"), id: z.string(), tags: z.array(z.string()) }),
]);

export const getEvalFlatSchema = z
  .object({
    eval_id: z.string().optional(),
    view: z.enum(["definition", "calibrations"]).optional(),
    grader_id: z.string().optional(),
    include_candidates: z.boolean().optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.eval_id === "string" && value.eval_id === "") {
      ctx.addIssue({ code: "custom", message: "eval_id must not be empty" });
      return;
    }
    if (value.eval_id === undefined) {
      if (value.view !== undefined || value.grader_id !== undefined || value.include_candidates !== undefined) {
        ctx.addIssue({ code: "custom", message: "eval_id is required when view or grader_id is set" });
      }
      return;
    }
    const view = value.view ?? "definition";
    if (view === "calibrations" && (value.grader_id === undefined || value.grader_id === "")) {
      ctx.addIssue({ code: "custom", message: "grader_id is required when view is calibrations" });
    }
  });

export const saveEvalFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    source: z.literal("sample").optional(),
    kind: z.enum(["stage", "agent"]).optional(),
    definition: record.optional(),
    directory: z.string().optional(),
    eval_id: z.string().optional(),
    base_hash: z.string().optional(),
    yaml: z.string().optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "create") {
      if (value.source === "sample") {
        if (value.definition !== undefined || value.yaml !== undefined || value.eval_id !== undefined) {
          ctx.addIssue({ code: "custom", message: "source sample does not take definition, yaml, or eval_id" });
        }
        return;
      }
      if (value.definition === undefined) {
        ctx.addIssue({ code: "custom", message: "definition is required for mode create without source sample" });
      }
      if (value.yaml !== undefined || value.eval_id !== undefined || value.base_hash !== undefined) {
        ctx.addIssue({ code: "custom", message: "mode create takes only definition and optional directory" });
      }
      return;
    }
    if (value.eval_id === undefined || value.eval_id === "") {
      ctx.addIssue({ code: "custom", message: "eval_id is required for mode update" });
    }
    if (value.base_hash === undefined || value.base_hash === "") {
      ctx.addIssue({ code: "custom", message: "base_hash is required for mode update" });
    }
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "update") return;
    const hasDefinition = value.definition !== undefined;
    const hasYaml = value.yaml !== undefined;
    if (hasDefinition === hasYaml) {
      ctx.addIssue({
        code: "custom",
        message: hasDefinition ? "Use either definition or yaml, not both" : "definition or yaml is required for mode update",
      });
    }
  });

export const saveDatasetFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    action: z.enum(["append", "replace", "ops", "convert"]).optional(),
    name: z.string().optional(),
    dataset_id: z.string().optional(),
    base_hash: z.string().optional(),
    source: z.enum(["sample", "runs", "sessions"]).optional(),
    target: datasetTargetObject.optional(),
    run_ids: z.array(z.string()).optional(),
    session_ids: z.array(z.string()).optional(),
    cases: z.array(record).optional(),
    ops: z.array(caseOpSchema).optional(),
    directory: z.string().optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "create") {
      if (value.action !== undefined || value.dataset_id !== undefined || value.base_hash !== undefined || value.ops !== undefined) {
        ctx.addIssue({ code: "custom", message: "mode create does not take action, dataset_id, base_hash, or ops" });
      }
      if (value.name === undefined || value.name === "") {
        ctx.addIssue({ code: "custom", message: "name is required for mode create" });
      }
      if (value.source === "runs" || value.source === "sessions" || value.source === "sample") {
        if (value.target === undefined) {
          ctx.addIssue({ code: "custom", message: `target is required when source is ${value.source}` });
        }
        if (value.source === "runs" && (value.run_ids === undefined || value.run_ids.length === 0)) {
          ctx.addIssue({ code: "custom", message: "run_ids is required when source is runs" });
        }
        if (value.source === "sessions" && (value.session_ids === undefined || value.session_ids.length === 0)) {
          ctx.addIssue({ code: "custom", message: "session_ids is required when source is sessions" });
        }
        if (value.cases !== undefined) {
          ctx.addIssue({ code: "custom", message: "cases cannot be set with source runs, sessions, or sample" });
        }
        return;
      }
      if (!Array.isArray(value.cases)) {
        ctx.addIssue({ code: "custom", message: "cases is required for mode create without source" });
      }
      return;
    }
    if (value.dataset_id === undefined || value.dataset_id === "") {
      ctx.addIssue({ code: "custom", message: "dataset_id is required for mode update" });
    }
    if (value.base_hash === undefined || value.base_hash === "") {
      ctx.addIssue({ code: "custom", message: "base_hash is required for mode update" });
    }
    if (value.action === undefined) {
      ctx.addIssue({ code: "custom", message: "action is required for mode update (append, replace, ops, or convert)" });
      return;
    }
    if (value.name !== undefined) {
      ctx.addIssue({ code: "custom", message: "name is only for mode create" });
    }
    switch (value.action) {
      case "ops":
        if (!Array.isArray(value.ops) || value.ops.length === 0) {
          ctx.addIssue({ code: "custom", message: "ops is required when action is ops" });
        }
        if (value.cases !== undefined || value.source !== undefined) {
          ctx.addIssue({ code: "custom", message: "action ops takes only ops" });
        }
        return;
      case "convert":
        if (value.cases !== undefined || value.ops !== undefined || value.source !== undefined) {
          ctx.addIssue({ code: "custom", message: "action convert takes only dataset_id and base_hash" });
        }
        return;
      case "append":
      case "replace":
        if (value.ops !== undefined) {
          ctx.addIssue({ code: "custom", message: "ops is only for action ops" });
        }
        if (value.source === "runs" || value.source === "sessions") {
          if (value.action === "replace") {
            ctx.addIssue({ code: "custom", message: `source ${value.source} requires action append` });
          }
          if (value.target === undefined) {
            ctx.addIssue({ code: "custom", message: `target is required when source is ${value.source}` });
          }
          return;
        }
        if (!Array.isArray(value.cases)) {
          ctx.addIssue({ code: "custom", message: "cases is required for action append or replace without source" });
        }
        if (value.source === "sample") {
          ctx.addIssue({ code: "custom", message: "source sample is only for mode create" });
        }
    }
  });

export const getEvalRunFlatSchema = z
  .object({
    eval_run_id: z.string().optional(),
    view: z.enum(["export"]).optional(),
    what: z.enum(["results", "config"]).optional(),
    eval_id: z.string().optional(),
    status: z.enum(EVAL_RUN_STATUSES).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.eval_run_id === "string" && value.eval_run_id === "") {
      ctx.addIssue({ code: "custom", message: "eval_run_id must not be empty" });
      return;
    }
    if (value.eval_run_id === undefined) {
      if (value.view !== undefined || value.what !== undefined) {
        ctx.addIssue({ code: "custom", message: "eval_run_id is required when view is set" });
      }
      return;
    }
    if (value.view === "export") return;
    if (value.eval_id !== undefined || value.status !== undefined || value.limit !== undefined) {
      ctx.addIssue({ code: "custom", message: "eval_id, status, and limit are only for listing runs" });
    }
  });

export const getEvalResultsFlatSchema = z
  .object({
    eval_run_id: z.string().min(1),
    case_id: z.string().optional(),
    status: z.string().optional(),
    grader: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.case_id !== undefined && value.case_id === "") {
      ctx.addIssue({ code: "custom", message: "case_id must not be empty" });
    }
    if (value.case_id !== undefined && (value.status !== undefined || value.grader !== undefined || value.limit !== undefined || value.cursor !== undefined)) {
      ctx.addIssue({ code: "custom", message: "case_id cannot be set with list filters or cursor" });
    }
  });

export const getEvalFailuresFlatSchema = z
  .object({
    eval_run_id: z.string().min(1),
    view: z.enum(["suggestions", "sort_status"]).optional(),
    status: z.enum(SUGGESTION_STATUSES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status !== undefined && (value.view ?? "suggestions") !== "suggestions") {
      ctx.addIssue({ code: "custom", message: "status filter is only for view suggestions" });
    }
  });

export const reviewEvalResultsFlatSchema = z
  .object({
    eval_run_id: z.string().min(1),
    action: z.enum(["label", "accept", "dismiss"]),
    case_id: z.string().optional(),
    repeat_index: z.number().int().min(0).optional(),
    label: z.string().optional(),
    note: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    ids: z.array(z.string()).optional(),
    min_confidence: z.number().optional(),
    bucket: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    switch (value.action) {
      case "label":
        if (value.case_id === undefined || value.repeat_index === undefined) {
          ctx.addIssue({ code: "custom", message: "case_id and repeat_index are required for action label" });
        }
        if (value.ids !== undefined || value.min_confidence !== undefined || value.bucket !== undefined) {
          ctx.addIssue({ code: "custom", message: "action label does not take ids, min_confidence, or bucket" });
        }
        return;
      case "accept":
        if (value.case_id !== undefined || value.repeat_index !== undefined || value.label !== undefined || value.note !== undefined || value.tags !== undefined) {
          ctx.addIssue({ code: "custom", message: "action accept does not take label fields" });
        }
        if (value.min_confidence !== undefined && (value.min_confidence < 0 || value.min_confidence > 1)) {
          ctx.addIssue({ code: "custom", message: "min_confidence must be from 0 to 1" });
        }
        if (value.bucket !== undefined && !TRIAGE_BUCKETS.includes(value.bucket as (typeof TRIAGE_BUCKETS)[number])) {
          ctx.addIssue({ code: "custom", message: `bucket must be one of ${TRIAGE_BUCKETS.join(", ")}` });
        }
        return;
      case "dismiss":
        if (value.ids === undefined || value.ids.length === 0) {
          ctx.addIssue({ code: "custom", message: "ids is required for action dismiss" });
        }
        if (value.case_id !== undefined || value.repeat_index !== undefined || value.label !== undefined) {
          ctx.addIssue({ code: "custom", message: "action dismiss takes only ids" });
        }
    }
  });

export const tryEvalCaseFlatSchema = z
  .object({
    eval_id: z.string().optional(),
    definition: record.optional(),
    case_id: z.string().optional(),
    case: record.optional(),
    dataset_cases: z.array(record).optional(),
    allow_real_tools: z.boolean().optional(),
    allow_host_login: z.boolean().optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasEvalId = value.eval_id !== undefined;
    const hasDefinition = value.definition !== undefined;
    if (hasEvalId === hasDefinition) {
      ctx.addIssue({
        code: "custom",
        message: hasEvalId ? "Use either eval_id or definition, not both" : "eval_id or definition is required",
      });
    }
    const hasCaseId = value.case_id !== undefined;
    const hasCase = value.case !== undefined;
    if (hasCaseId === hasCase) {
      ctx.addIssue({
        code: "custom",
        message: hasCaseId ? "Use either case_id or case, not both" : "case_id or case is required",
      });
    }
  });

export const runEvalFlatSchema = z.object({
  eval_id: z.string(),
  repeats: z.number().int().min(EVAL_LIMITS.repeats.min).max(EVAL_LIMITS.repeats.max).optional(),
  judge: z.string().optional(),
  model: z.string().optional().describe("Override the stage or agent model"),
  user_model: z.string().optional(),
  allow_real_tools: z.boolean().optional(),
  allow_host_login: z.boolean().optional(),
  tools: z.enum(["read_only", "mocked"]).optional(),
  approvals: z.enum(["deny", "record_only"]).optional(),
  max_cost_usd: z.number().positive().optional(),
  case_ids: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  only_failed_from: z.string().optional(),
  label: z.string().max(EVAL_LIMITS.labelMaxChars).optional(),
  wait: z.boolean().optional(),
  timeout_ms: z.number().int().min(1).max(1_800_000).optional(),
  project_root: projectRootField,
});

export const resolveGetEvalMode: ModeResolver = (args) => {
  const data = parseOrReject(getEvalFlatSchema, args, "get_eval");
  if (isResolverResult(data)) return data;
  if (data.eval_id === undefined) return ok("list");
  const view = data.view ?? "definition";
  return ok(view, data.eval_id);
};

export const resolveSaveEvalMode: ModeResolver = (args) => {
  const data = parseOrReject(saveEvalFlatSchema, args, "save_eval");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") {
    if (data.source === "sample") return ok("install_sample");
    return ok("create");
  }
  return ok("update", data.eval_id);
};

export const resolveSaveDatasetMode: ModeResolver = (args) => {
  const data = parseOrReject(saveDatasetFlatSchema, args, "save_dataset");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") return ok("create", data.name);
  return ok(data.action!, data.dataset_id);
};

export const resolveGetEvalRunMode: ModeResolver = (args) => {
  const data = parseOrReject(getEvalRunFlatSchema, args, "get_eval_run");
  if (isResolverResult(data)) return data;
  if (data.eval_run_id === undefined) return ok("list");
  if (data.view === "export") return ok("export", data.eval_run_id);
  return ok("detail", data.eval_run_id);
};

export const resolveGetEvalResultsMode: ModeResolver = (args) => {
  const data = parseOrReject(getEvalResultsFlatSchema, args, "get_eval_results");
  if (isResolverResult(data)) return data;
  if (data.case_id !== undefined) return ok("case", data.eval_run_id);
  return ok("list", data.eval_run_id);
};

export const resolveGetEvalFailuresMode: ModeResolver = (args) => {
  const data = parseOrReject(getEvalFailuresFlatSchema, args, "get_eval_failures");
  if (isResolverResult(data)) return data;
  const view = data.view ?? "suggestions";
  return ok(view, data.eval_run_id);
};

export const resolveReviewEvalResultsMode: ModeResolver = (args) => {
  const data = parseOrReject(reviewEvalResultsFlatSchema, args, "review_eval_results");
  if (isResolverResult(data)) return data;
  return ok(data.action, data.eval_run_id);
};

export const EVAL_TOOL_MODE_RESOLVERS: Readonly<Record<string, ModeResolver>> = {
  get_eval: resolveGetEvalMode,
  save_eval: resolveSaveEvalMode,
  save_dataset: resolveSaveDatasetMode,
  get_eval_run: resolveGetEvalRunMode,
  get_eval_results: resolveGetEvalResultsMode,
  get_eval_failures: resolveGetEvalFailuresMode,
  review_eval_results: resolveReviewEvalResultsMode,
};