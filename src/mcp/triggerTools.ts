import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { createTrigger, parseCreateTriggerBody } from "../config/createTrigger.js";
import { parsePatchTriggerBody, parsePutTriggerBody, updateTriggerDefinition, updateTriggerEnabled } from "../config/updateTrigger.js";
import { readTriggerAdapterStatus } from "../config/triggerAdapterStatus.js";
import { loadCatalogTriggers, type TriggerListItem } from "../config/triggerCatalog.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { fireTrigger } from "../runtime/triggerRunner.js";
import { mapStartFailure } from "../server/operatorResults.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "../server/requestAuthContext.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const auditLog = rootLogger.child({ component: "audit" });

const triggerScheduleSchema = z.object({
  cron: z.string(),
  timezone: z.string().optional(),
});

const gitIdentitySchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
});

/**
 * Same shape as TaskFile (src/types/task.ts), duplicated locally the same way
 * src/mcp/catalogTools.ts's own taskFileSchema is: deliberately not shared
 * across module boundaries for a schema this small.
 */
const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
  repository: z.string().optional(),
  ref: z.string().optional(),
  run_branch_template: z.string().optional(),
  git_identity: gitIdentitySchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const triggerEventSchema = z.object({
  source: z.string(),
  match: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

function findListedTrigger(
  items: TriggerListItem[],
  id: string,
  projectRoot?: string,
): TriggerListItem | { error: string; status: 404 | 409; project_roots?: string[] } {
  if (projectRoot) {
    const found = items.find((item) => item.id === id && item.project_root === projectRoot);
    if (!found) return { error: `Trigger not found: ${id}`, status: 404 };
    return found;
  }
  const matches = items.filter((item) => item.id === id);
  if (matches.length === 0) return { error: `Trigger not found: ${id}`, status: 404 };
  if (matches.length > 1) {
    return {
      error: `Trigger id is ambiguous across catalog roots: ${id}`,
      status: 409,
      project_roots: [...new Set(matches.map((item) => item.project_root))].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }
  return matches[0]!;
}

const triggerProjectRoot = z
  .string()
  .optional()
  .describe(
    "Catalog project root to write into; required when multiple catalog roots are configured and no sole non-seeded root exists",
  );

const triggerTask = z
  .string()
  .optional()
  .describe(
    "Catalog task id; omit to create a dynamic-mode trigger whose task is supplied at fire time",
  );

const createTriggerBase = {
  project_root: triggerProjectRoot,
  directory: z.string(),
  id: z.string(),
  pipeline: z.string(),
  task: triggerTask,
  enabled: z.boolean().optional(),
};

const createTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ ...createTriggerBase, kind: z.literal("manual") }),
  z.object({ ...createTriggerBase, kind: z.literal("schedule"), schedule: triggerScheduleSchema }),
  z.object({ ...createTriggerBase, kind: z.literal("event"), event: triggerEventSchema }),
]);

const updateTriggerBase = {
  id: z.string(),
  project_root: z.string().optional(),
  pipeline: z.string(),
  task: z.string().optional(),
  enabled: z.boolean(),
};

const updateTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ ...updateTriggerBase, kind: z.literal("manual") }),
  z.object({ ...updateTriggerBase, kind: z.literal("schedule"), schedule: triggerScheduleSchema }),
  z.object({ ...updateTriggerBase, kind: z.literal("event"), event: triggerEventSchema }),
]);

export function registerTriggerTools(server: McpServer, deps: McpToolDeps): void {
  const { store, cwd, manager } = deps;

  server.registerTool(
    "list_triggers",
    {
      description:
        "List catalog-declared triggers (same source as GET /api/triggers): manual/schedule/event kind, enabled, and store-recorded last_fired_at/last_run_id/next_run_at when present.",
      inputSchema: z.object({}),
    },
    async () => {
      const items = await loadCatalogTriggers({ store, bootCwd: cwd });
      const triggers = await Promise.all(
        items.map(async (item) => ({
          ...item,
          adapter_status: await readTriggerAdapterStatus(item, store),
        })),
      );
      return textResult({ triggers });
    },
  );

  server.registerTool(
    "get_trigger",
    {
      description:
        "Look up one catalog trigger by id (same source as GET /api/triggers/:id).",
      inputSchema: z.object({
        id: z.string(),
        project_root: z
          .string()
          .optional()
          .describe("Catalog project root; required when the same trigger id exists in more than one root"),
      }),
    },
    async ({ id, project_root }) => {
      const items = await loadCatalogTriggers({ store, bootCwd: cwd });
      const found = findListedTrigger(items, id, project_root);
      if ("error" in found) {
        return textResult(
          { error: found.error, status: found.status, ...(found.project_roots ? { project_roots: found.project_roots } : {}) },
          true,
        );
      }
      return textResult({
        ...found,
        adapter_status: await readTriggerAdapterStatus(found, store),
      });
    },
  );

  server.registerTool(
    "fire_trigger",
    {
      description:
        "Fire a catalog trigger by id: resolves its pipeline/task refs and starts a run through the same RunManager.startRun path as start_run (same as POST /api/triggers/:id/fire). Returns { runId } or { runId, queued: true, queuePosition }. Fails not_found (404) for an unknown id, or 409 when the trigger is disabled.",
      inputSchema: z.object({
        id: z.string(),
        project_root: z
          .string()
          .optional()
          .describe("Catalog project root; required when the same trigger id exists in more than one root"),
        task: taskFileSchema
          .optional()
          .describe(
            "Inline TaskFile, required to fire a dynamic-mode trigger (no catalog task) and rejected for a catalog-mode trigger",
          ),
      }),
    },
    async ({ id, task, project_root }) => {
      const callerId = callerIdFromRequestAuth();
      const result = await fireTrigger(id, store, manager, {
        cwd,
        task,
        ...(project_root ? { project_root } : {}),
      });
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "trigger_fire",
          outcome: "error",
          error_code: result.code,
        });
        return textResult(
          {
            ...mapStartFailure(result),
            ...(result.status !== undefined ? { status: result.status } : {}),
          },
          true,
        );
      }
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "trigger_fire",
        target_run_id: result.runId,
        outcome: "ok",
      });
      return textResult({
        runId: result.runId,
        ...(result.queued === true
          ? {
              queued: true,
              queuePosition: result.queuePosition,
              ...(result.queuedCode !== undefined
                ? { queuedCode: result.queuedCode }
                : {}),
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "create_trigger",
    {
      description:
        "Create a new *.trigger.yaml in the catalog (same validation/write path as POST /api/triggers): validates id format/uniqueness, pipeline/task refs, and kind-specific shape (schedule.cron parses via croner; event.source is required), writes the file, and re-loads it to confirm it round-trips. Returns the created trigger.",
      inputSchema: createTriggerSchema,
    },
    async ({ project_root, ...body }) => {
      const callerId = callerIdFromRequestAuth();
      let wireRoot;
      try {
        ({ wireRoot } = await resolveWritableCatalogRoot({ store, bootCwd: cwd }, project_root));
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
        throw err;
      }

      const parsed = parseCreateTriggerBody(body);
      if ("ok" in parsed) {
        return textResult({ error: parsed.error, status: parsed.status }, true);
      }

      const stageflowCtx = await resolveStageflowContext(wireRoot.path);
      if (stageflowCtx.manifestStatus !== "ok") {
        return textResult(
          {
            error: "Project root not found; initialize stageflow.yaml",
            status: 400,
          },
          true,
        );
      }

      const result = await createTrigger(stageflowCtx.projectRoot, parsed);
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "trigger_create",
          outcome: "error",
        });
        return textResult({ error: result.error, status: result.status }, true);
      }
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "trigger_create",
        outcome: "ok",
      });
      return textResult(result.trigger);
    },
  );

  server.registerTool(
    "update_trigger",
    {
      description: "Replace a trigger's definition (pipeline, task, kind, schedule or event, enabled). Same validation and write path as PUT /api/triggers/:id; the id cannot change.",
      inputSchema: updateTriggerSchema,
    },
    async ({ id, project_root, ...body }) => {
      const parsed = parsePutTriggerBody(body, id);
      if ("ok" in parsed) return textResult({ error: parsed.error, status: parsed.status }, true);
      const result = await updateTriggerDefinition(cwd, store, id, parsed, { projectRootFilter: project_root });
      writeAudit(auditLog, { caller_id: callerIdFromRequestAuth(), surface: getRequestAuth()?.surface ?? "mcp", action: "trigger_update", outcome: result.ok ? "ok" : "error" });
      return result.ok ? textResult(result.trigger) : textResult({ error: result.error, status: result.status }, true);
    },
  );

  server.registerTool(
    "set_trigger_enabled",
    {
      description: "Enable or disable a trigger. Same write path as PATCH /api/triggers/:id.",
      inputSchema: z.object({ id: z.string(), enabled: z.boolean(), project_root: z.string().optional() }),
    },
    async ({ id, enabled, project_root }) => {
      const parsed = parsePatchTriggerBody({ enabled });
      if ("ok" in parsed) return textResult({ error: parsed.error, status: parsed.status }, true);
      const result = await updateTriggerEnabled(cwd, store, id, parsed.enabled, { projectRootFilter: project_root });
      writeAudit(auditLog, { caller_id: callerIdFromRequestAuth(), surface: getRequestAuth()?.surface ?? "mcp", action: "trigger_patch", outcome: result.ok ? "ok" : "error" });
      return result.ok ? textResult(result.trigger) : textResult({ error: result.error, status: result.status }, true);
    },
  );
}
