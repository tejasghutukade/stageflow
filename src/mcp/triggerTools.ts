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
import {
  fireTriggerTaskFileSchema,
  getTriggerFlatSchema,
  saveTriggerCreateSchema,
  saveTriggerEnabledOnlySchema,
  saveTriggerFlatSchema,
  saveTriggerUpdateFullSchema,
} from "../toolkit/triggerConnectionMemoryToolModes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const auditLog = rootLogger.child({ component: "audit" });

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

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

function isEnabledOnlyUpdate(args: Record<string, unknown>): boolean {
  const keys = Object.keys(args).filter((key) => key !== "mode" && args[key] !== undefined);
  return keys.every((key) => key === "id" || key === "enabled" || key === "project_root");
}

export function registerTriggerTools(server: McpServer, deps: McpToolDeps): void {
  const { store, cwd, manager } = deps;

  server.registerTool(
    "get_trigger",
    {
      description:
        "List catalog triggers without id, or look up one trigger by id. Unknown ids return not_found, never a list.",
      inputSchema: getTriggerFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getTriggerFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const items = await loadCatalogTriggers({ store, bootCwd: cwd });
      if (parsed.data.id === undefined) {
        const triggers = await Promise.all(
          items.map(async (item) => ({
            ...item,
            adapter_status: await readTriggerAdapterStatus(item, store),
          })),
        );
        return textResult({ triggers });
      }
      const { id, project_root } = parsed.data;
      const found = findListedTrigger(items, id, project_root);
      if ("error" in found) {
        return textResult(
          {
            error: found.error,
            status: found.status,
            ...(found.project_roots ? { project_roots: found.project_roots } : {}),
          },
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
        "Fire a catalog trigger by id: resolves its pipeline/task refs and starts a run through the same RunManager.startRun path as start_run. Returns { runId } or { runId, queued: true, queuePosition }. Fails not_found (404) for an unknown id, or 409 when the trigger is disabled.",
      inputSchema: z.object({
        id: z.string(),
        project_root: z
          .string()
          .optional()
          .describe("Catalog project root; required when the same trigger id exists in more than one root"),
        task: fireTriggerTaskFileSchema
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
    "save_trigger",
    {
      description:
        "Create or update a catalog trigger. mode create writes a new *.trigger.yaml. mode update replaces the definition or changes only enabled.",
      inputSchema: saveTriggerFlatSchema,
    },
    async (args) => {
      const parsed = saveTriggerFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const { mode, ...rest } = args;
      if (mode === "create") {
        const body = saveTriggerCreateSchema.safeParse(rest);
        if (!body.success) return schemaError(body.error.issues[0]?.message ?? "Invalid arguments");
        const { project_root, ...createBody } = body.data;
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

        const createParsed = parseCreateTriggerBody({
          ...createBody,
          enabled: createBody.enabled ?? false,
        });
        if ("ok" in createParsed) {
          return textResult({ error: createParsed.error, status: createParsed.status }, true);
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

        const result = await createTrigger(stageflowCtx.projectRoot, createParsed);
        if (!result.ok) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "trigger_create",
            outcome: "error",
          });
          return textResult(
            {
              error: result.error,
              status: result.status,
              ...(result.status === 409 ? { code: "trigger_EXISTS" } : {}),
            },
            true,
          );
        }
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "trigger_create",
          outcome: "ok",
        });
        return textResult(result.trigger);
      }

      if (isEnabledOnlyUpdate(args)) {
        const patchBody = saveTriggerEnabledOnlySchema.safeParse(rest);
        if (!patchBody.success) return schemaError(patchBody.error.issues[0]?.message ?? "Invalid arguments");
        const { id, enabled, project_root } = patchBody.data;
        const patchParsed = parsePatchTriggerBody({ enabled });
        if ("ok" in patchParsed) return textResult({ error: patchParsed.error, status: patchParsed.status }, true);
        const result = await updateTriggerEnabled(cwd, store, id, patchParsed.enabled, {
          projectRootFilter: project_root,
        });
        writeAudit(auditLog, {
          caller_id: callerIdFromRequestAuth(),
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "trigger_patch",
          outcome: result.ok ? "ok" : "error",
        });
        return result.ok
          ? textResult(result.trigger)
          : textResult({ error: result.error, status: result.status }, true);
      }

      const updateBody = saveTriggerUpdateFullSchema.safeParse(rest);
      if (!updateBody.success) return schemaError(updateBody.error.issues[0]?.message ?? "Invalid arguments");
      const { id, project_root, ...putBody } = updateBody.data;
      const putParsed = parsePutTriggerBody(putBody, id);
      if ("ok" in putParsed) return textResult({ error: putParsed.error, status: putParsed.status }, true);
      const result = await updateTriggerDefinition(cwd, store, id, putParsed, { projectRootFilter: project_root });
      writeAudit(auditLog, {
        caller_id: callerIdFromRequestAuth(),
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "trigger_update",
        outcome: result.ok ? "ok" : "error",
      });
      return result.ok ? textResult(result.trigger) : textResult({ error: result.error, status: result.status }, true);
    },
  );
}