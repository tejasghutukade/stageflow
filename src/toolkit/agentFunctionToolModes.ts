import { z } from "zod";
import { SESSION_STATUSES } from "../agents/store.js";
import { AGENT_ID_PATTERN } from "../config/loadAgent.js";
import type { ModeResolver } from "./modes.js";
import { isResolverResult, ok, parseOrReject } from "./modeResolverHelpers.js";

const agentId = z.string().regex(AGENT_ID_PATTERN);
const functionId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const record = z.record(z.string(), z.unknown());
const projectRootField = z.string().optional();

export const getAgentFlatSchema = z
  .object({
    id: agentId.optional(),
    view: z.enum(["definition", "revisions", "revision", "diff"]).optional(),
    revision: z.number().int().positive().optional(),
    from: z.number().int().positive().optional(),
    to: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.id === "string" && value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
      return;
    }
    if (value.id === undefined) {
      if (value.view !== undefined || value.revision !== undefined || value.from !== undefined || value.to !== undefined) {
        ctx.addIssue({ code: "custom", message: "id is required when view or revision fields are set" });
      }
      return;
    }
    const view = value.view ?? "definition";
    if (view === "revision" && value.revision === undefined) {
      ctx.addIssue({ code: "custom", message: "revision is required when view is revision" });
    }
    if (view === "diff") {
      if (value.from === undefined) {
        ctx.addIssue({ code: "custom", message: "from is required when view is diff" });
      }
      if (value.to === undefined) {
        ctx.addIssue({ code: "custom", message: "to is required when view is diff" });
      }
    }
  });

export const getAgentSessionFlatSchema = z
  .object({
    id: agentId,
    sessionId: z.string().optional(),
    status: z.enum(SESSION_STATUSES).optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.id === "string" && value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
    }
    if (value.sessionId !== undefined && !value.sessionId.trim()) {
      ctx.addIssue({ code: "custom", message: "sessionId must not be empty" });
    }
  });

export const saveAgentFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    id: agentId.optional(),
    baseRevision: z.number().int().nonnegative().optional(),
    definition: record.optional(),
    revision: z.number().int().positive().optional(),
    summary: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "create") {
      if (value.definition === undefined) {
        ctx.addIssue({ code: "custom", message: "definition is required for mode create" });
      }
      if (value.id !== undefined || value.baseRevision !== undefined || value.revision !== undefined) {
        ctx.addIssue({ code: "custom", message: "mode create takes only definition" });
      }
      return;
    }
    if (value.id === undefined) {
      ctx.addIssue({ code: "custom", message: "id is required for mode update" });
      return;
    }
    if (value.baseRevision === undefined) {
      ctx.addIssue({ code: "custom", message: "baseRevision is required for mode update" });
    }
    const hasDefinition = value.definition !== undefined;
    const hasRevision = value.revision !== undefined;
    if (hasDefinition === hasRevision) {
      ctx.addIssue({
        code: "custom",
        message: hasDefinition
          ? "Use either definition or revision, not both"
          : "definition or revision is required for mode update",
      });
    }
  });

export const setAgentEnabledFlatSchema = z
  .object({
    id: agentId,
    enabled: z.boolean(),
  })
  .strict();

export const decideAgentActionFlatSchema = z
  .object({
    id: agentId,
    sessionId: z.string().min(1),
    action: z.enum(["approve", "deny"]),
  })
  .strict();

export const getFunctionFlatSchema = z
  .object({
    id: functionId.optional(),
    view: z.enum(["definition", "revisions", "revision"]).optional(),
    revision: z.number().int().positive().optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.id === "string" && value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
      return;
    }
    if (value.id === undefined) return;
    const view = value.view ?? "definition";
    if (view === "revision" && value.revision === undefined) {
      ctx.addIssue({ code: "custom", message: "revision is required when view is revision" });
    }
  });

export const saveFunctionFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    id: functionId.optional(),
    copy_from: functionId.optional(),
    baseRevision: z.number().int().nonnegative().optional(),
    definition: record.optional(),
    summary: z.string().max(200).optional(),
    format: z.enum(["js", "yaml", "yml"]).optional(),
    project_root: projectRootField,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "create") {
      const hasCopy = value.copy_from !== undefined;
      const hasDefinition = value.definition !== undefined;
      if (hasCopy) {
        if (value.id === undefined) {
          ctx.addIssue({ code: "custom", message: "id is required when copy_from is set" });
        }
        if (hasDefinition) {
          ctx.addIssue({ code: "custom", message: "Use either definition or copy_from, not both" });
        }
        if (value.baseRevision !== undefined) {
          ctx.addIssue({ code: "custom", message: "baseRevision is not used for mode create" });
        }
        return;
      }
      if (!hasDefinition) {
        ctx.addIssue({ code: "custom", message: "definition is required for mode create" });
      }
      return;
    }
    if (value.id === undefined) {
      ctx.addIssue({ code: "custom", message: "id is required for mode update" });
    }
    if (value.baseRevision === undefined) {
      ctx.addIssue({ code: "custom", message: "baseRevision is required for mode update" });
    }
    if (value.definition === undefined) {
      ctx.addIssue({ code: "custom", message: "definition is required for mode update" });
    }
    if (value.copy_from !== undefined) {
      ctx.addIssue({ code: "custom", message: "copy_from is only for mode create" });
    }
  });

export const resolveGetAgentMode: ModeResolver = (args) => {
  const data = parseOrReject(getAgentFlatSchema, args, "get_agent");
  if (isResolverResult(data)) return data;
  if (data.id === undefined) return ok("list");
  const view = data.view ?? "definition";
  return ok(view, data.id);
};

export const resolveGetAgentSessionMode: ModeResolver = (args) => {
  const data = parseOrReject(getAgentSessionFlatSchema, args, "get_agent_session");
  if (isResolverResult(data)) return data;
  if (data.sessionId !== undefined) return ok("detail", data.id);
  return ok("list", data.id);
};

export const resolveSaveAgentMode: ModeResolver = (args) => {
  const data = parseOrReject(saveAgentFlatSchema, args, "save_agent");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") return ok("create");
  if (data.revision !== undefined) return ok("restore", data.id);
  return ok("update", data.id);
};

export const resolveSetAgentEnabledMode: ModeResolver = (args) => {
  const data = parseOrReject(setAgentEnabledFlatSchema, args, "set_agent_enabled");
  if (isResolverResult(data)) return data;
  return ok(data.enabled ? "enable" : "disable", data.id);
};

export const resolveDecideAgentActionMode: ModeResolver = (args) => {
  const data = parseOrReject(decideAgentActionFlatSchema, args, "decide_agent_action");
  if (isResolverResult(data)) return data;
  return ok(data.action, data.id);
};

export const resolveGetFunctionMode: ModeResolver = (args) => {
  const data = parseOrReject(getFunctionFlatSchema, args, "get_function");
  if (isResolverResult(data)) return data;
  if (data.id === undefined) return ok("list");
  const view = data.view ?? "definition";
  return ok(view, data.id);
};

export const resolveSaveFunctionMode: ModeResolver = (args) => {
  const data = parseOrReject(saveFunctionFlatSchema, args, "save_function");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") {
    if (data.copy_from !== undefined) return ok("duplicate", data.id);
    return ok("create");
  }
  return ok("update", data.id);
};

export const AGENT_FUNCTION_TOOL_MODE_RESOLVERS: Readonly<Record<string, ModeResolver>> = {
  get_agent: resolveGetAgentMode,
  get_agent_session: resolveGetAgentSessionMode,
  save_agent: resolveSaveAgentMode,
  set_agent_enabled: resolveSetAgentEnabledMode,
  decide_agent_action: resolveDecideAgentActionMode,
  get_function: resolveGetFunctionMode,
  save_function: resolveSaveFunctionMode,
};