import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { createTrigger, parseCreateTriggerBody } from "../config/createTrigger.js";
import { loadCatalogTriggers } from "../config/triggerCatalog.js";
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

const triggerEventSchema = z.object({
  source: z.string(),
  match: z.record(z.string(), z.unknown()).optional(),
});

const createTriggerSchema = z.object({
  project_root: z
    .string()
    .optional()
    .describe(
      "Catalog project root to write into; required when multiple catalog roots are configured and no sole non-seeded root exists",
    ),
  directory: z.string(),
  id: z.string(),
  pipeline: z.string(),
  task: z.string(),
  kind: z.enum(["manual", "schedule", "event"]),
  schedule: triggerScheduleSchema.optional(),
  event: triggerEventSchema.optional(),
  enabled: z.boolean().optional(),
});

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
      const items = await loadCatalogTriggers(cwd, store);
      if (items === undefined) {
        return textResult({ error: "No Stageflow catalog found", status: 404 }, true);
      }
      return textResult({ triggers: items });
    },
  );

  server.registerTool(
    "get_trigger",
    {
      description:
        "Look up one catalog trigger by id (same source as GET /api/triggers/:id).",
      inputSchema: z.object({
        id: z.string(),
      }),
    },
    async ({ id }) => {
      const items = await loadCatalogTriggers(cwd, store);
      if (items === undefined) {
        return textResult({ error: "No Stageflow catalog found", status: 404 }, true);
      }
      const found = items.find((item) => item.id === id);
      if (!found) {
        return textResult({ error: `Trigger not found: ${id}`, status: 404 }, true);
      }
      return textResult(found);
    },
  );

  server.registerTool(
    "fire_trigger",
    {
      description:
        "Fire a catalog trigger by id: resolves its pipeline/task refs and starts a run through the same RunManager.startRun path as start_run (same as POST /api/triggers/:id/fire). Returns { runId } or { runId, queued: true, queuePosition }. Fails not_found (404) for an unknown id, or 409 when the trigger is disabled.",
      inputSchema: z.object({
        id: z.string(),
      }),
    },
    async ({ id }) => {
      const callerId = callerIdFromRequestAuth();
      const result = await fireTrigger(id, store, manager, { cwd });
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
      if (!stageflowCtx.isGitProject) {
        return textResult(
          {
            error: "Project root not found; initialize stageflow.yaml in a git repo",
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
}
