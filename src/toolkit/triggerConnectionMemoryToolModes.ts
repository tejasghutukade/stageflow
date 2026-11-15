import { z } from "zod";
import type { ModeResolver } from "./modes.js";
import { isResolverResult, ok, parseOrReject } from "./modeResolverHelpers.js";
import { taskFileSchema } from "./runToolModes.js";

const triggerScheduleSchema = z.object({
  cron: z.string(),
  timezone: z.string().optional(),
});

const triggerEventSchema = z.object({
  source: z.string(),
  match: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const triggerProjectRoot = z.string().optional();

const secretValues = z.record(z.string(), z.string());
const configValues = z.record(z.string(), z.unknown());
const credentialInput = z.union([
  z.string(),
  z.object({
    id: z.string().optional(),
    secrets: secretValues,
  }),
]);

const targetValue = z.union([z.string(), z.number().int()]);

export const getTriggerFlatSchema = z
  .object({
    id: z.string().optional(),
    project_root: triggerProjectRoot,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.id === "string" && value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
    }
  });

const saveTriggerCreateBase = {
  project_root: triggerProjectRoot,
  directory: z.string(),
  id: z.string(),
  pipeline: z.string(),
  task: z.string().optional(),
  enabled: z.boolean().optional(),
};

const saveTriggerCreateKinds = z.discriminatedUnion("kind", [
  z.object({ ...saveTriggerCreateBase, kind: z.literal("manual") }),
  z.object({ ...saveTriggerCreateBase, kind: z.literal("schedule"), schedule: triggerScheduleSchema }),
  z.object({ ...saveTriggerCreateBase, kind: z.literal("event"), event: triggerEventSchema }),
]);

const saveTriggerUpdateFullBase = {
  id: z.string(),
  project_root: triggerProjectRoot,
  pipeline: z.string(),
  task: z.string().optional(),
  enabled: z.boolean(),
};

const saveTriggerUpdateFull = z.discriminatedUnion("kind", [
  z.object({ ...saveTriggerUpdateFullBase, kind: z.literal("manual") }),
  z.object({ ...saveTriggerUpdateFullBase, kind: z.literal("schedule"), schedule: triggerScheduleSchema }),
  z.object({ ...saveTriggerUpdateFullBase, kind: z.literal("event"), event: triggerEventSchema }),
]);

const saveTriggerEnabledOnly = z
  .object({
    id: z.string(),
    project_root: triggerProjectRoot,
    enabled: z.boolean(),
  })
  .strict();

export const saveTriggerFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const { mode, ...rest } = value;
    if (mode === "create") {
      const parsed = saveTriggerCreateKinds.safeParse(rest);
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          message: parsed.error.issues[0]?.message ?? "Invalid create trigger arguments",
        });
      }
      return;
    }
    const enabledOnly = saveTriggerEnabledOnly.safeParse(rest);
    if (enabledOnly.success) return;
    const full = saveTriggerUpdateFull.safeParse(rest);
    if (!full.success) {
      ctx.addIssue({
        code: "custom",
        message:
          full.error.issues[0]?.message ??
          "mode update requires a full trigger definition or only id and enabled",
      });
    }
  });

export const getConnectionFlatSchema = z.object({}).strict();

const saveConnectionCreate = z
  .object({
    provider: z.string(),
    id: z.string().optional(),
    displayName: z.string().optional(),
    config: configValues.optional(),
    secrets: secretValues.optional(),
    credential: credentialInput.optional(),
  })
  .strict();

const saveConnectionUpdate = z
  .object({
    id: z.string(),
    enabled: z.boolean().optional(),
    displayName: z.string().nullable().optional(),
    config: configValues.optional(),
    secrets: secretValues.optional(),
  })
  .strict();

export const saveConnectionFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const { mode, ...rest } = value;
    const schema = mode === "create" ? saveConnectionCreate : saveConnectionUpdate;
    const parsed = schema.safeParse(rest);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: parsed.error.issues[0]?.message ?? `Invalid save_connection arguments for mode ${mode}`,
      });
    }
  });

export const getMemoryFlatSchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (typeof value.id === "string" && value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
    }
  });

export const saveMemoryFlatSchema = z
  .object({
    mode: z.enum(["create", "update"]),
    id: z.string(),
    description: z.string().optional(),
    body: z.string().optional(),
    card: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.id === "") {
      ctx.addIssue({ code: "custom", message: "id must not be empty" });
      return;
    }
    if (value.mode === "create") {
      if (value.description === undefined) {
        ctx.addIssue({ code: "custom", message: "description is required for mode create" });
      }
      if (value.body !== undefined || value.card !== undefined) {
        ctx.addIssue({ code: "custom", message: "mode create takes only id and description" });
      }
      return;
    }
    if (value.card !== undefined) {
      if (value.body === undefined) {
        ctx.addIssue({ code: "custom", message: "body is required when card is set" });
      }
      return;
    }
    if (value.body === undefined) {
      ctx.addIssue({ code: "custom", message: "body is required for mode update without card" });
    }
    if (value.description !== undefined) {
      ctx.addIssue({ code: "custom", message: "description is only for mode create" });
    }
  });

function isEnabledOnlyTriggerUpdate(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data).filter((key) => key !== "mode" && data[key] !== undefined);
  return keys.every((key) => key === "id" || key === "enabled" || key === "project_root");
}

export const resolveGetTriggerMode: ModeResolver = (args) => {
  const data = parseOrReject(getTriggerFlatSchema, args, "get_trigger");
  if (isResolverResult(data)) return data;
  if (data.id === undefined) return ok("list");
  return ok("detail", data.id);
};

export const resolveSaveTriggerMode: ModeResolver = (args) => {
  const data = parseOrReject(saveTriggerFlatSchema, args, "save_trigger");
  if (isResolverResult(data)) return data;
  const id = typeof data.id === "string" ? data.id : undefined;
  if (data.mode === "create") {
    if (data.enabled === true) return ok("create_enabled");
    return ok("create");
  }
  if (isEnabledOnlyTriggerUpdate(data)) {
    return ok(data.enabled === true ? "enable" : "disable", id);
  }
  return ok("update", id);
};

export const resolveGetConnectionMode: ModeResolver = (args) => {
  const data = parseOrReject(getConnectionFlatSchema, args, "get_connection");
  if (isResolverResult(data)) return data;
  return ok("list");
};

export const resolveSaveConnectionMode: ModeResolver = (args) => {
  const data = parseOrReject(saveConnectionFlatSchema, args, "save_connection");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") return ok("create");
  const id = typeof args.id === "string" ? args.id : undefined;
  return ok("update", id);
};

export const resolveGetMemoryMode: ModeResolver = (args) => {
  const data = parseOrReject(getMemoryFlatSchema, args, "get_memory");
  if (isResolverResult(data)) return data;
  if (data.id === undefined) return ok("list");
  return ok("detail", data.id);
};

export const resolveSaveMemoryMode: ModeResolver = (args) => {
  const data = parseOrReject(saveMemoryFlatSchema, args, "save_memory");
  if (isResolverResult(data)) return data;
  if (data.mode === "create") return ok("create", data.id);
  if (data.card !== undefined) return ok("card", data.id);
  return ok("cover", data.id);
};

export const TRIGGER_CONNECTION_MEMORY_TOOL_MODE_RESOLVERS: Readonly<Record<string, ModeResolver>> = {
  get_trigger: resolveGetTriggerMode,
  save_trigger: resolveSaveTriggerMode,
  get_connection: resolveGetConnectionMode,
  save_connection: resolveSaveConnectionMode,
  get_memory: resolveGetMemoryMode,
  save_memory: resolveSaveMemoryMode,
};

export const fireTriggerTaskFileSchema = taskFileSchema;
export const saveConnectionCreateSchema = saveConnectionCreate;
export const saveConnectionUpdateSchema = saveConnectionUpdate;
export const saveTriggerCreateSchema = saveTriggerCreateKinds;
export const saveTriggerEnabledOnlySchema = saveTriggerEnabledOnly;
export const saveTriggerUpdateFullSchema = saveTriggerUpdateFull;