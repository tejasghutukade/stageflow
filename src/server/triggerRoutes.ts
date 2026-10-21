import type { IncomingMessage, ServerResponse } from "node:http";
import { fireTrigger } from "../runtime/triggerRunner.js";
import { acceptWebhook } from "../runtime/webhookAccept.js";
import { mapStartFailure } from "./operatorResults.js";
import { writeAudit } from "../logging/audit.js";
import type { Logger } from "../logging/logger.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "./requestAuthContext.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunStore } from "../runstore/port.js";
import {
  findCatalogTrigger,
  loadCatalogTriggers,
  triggerStoreId,
  type TriggerListItem,
} from "../config/triggerCatalog.js";
import { createTrigger, parseCreateTriggerBody } from "../config/createTrigger.js";
import {
  parsePatchTriggerBody,
  parsePutTriggerBody,
  updateTriggerDefinition,
  updateTriggerEnabled,
  projectRootFilterFromBody,
} from "../config/updateTrigger.js";
import {
  readTriggerAdapterStatus,
  type TriggerAdapterStatus,
} from "../config/triggerAdapterStatus.js";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { catalogContextFromStageflow } from "../config/resolveCatalogContext.js";
import { getCatalogScanPaths } from "../config/browseCatalog.js";
import { coerceTaskFile } from "../config/loadTask.js";
import type { TaskFile } from "../types/task.js";
export type { TriggerListItem } from "../config/triggerCatalog.js";
export type { TriggerAdapterStatus } from "../config/triggerAdapterStatus.js";

async function enrichTriggerListItem(
  item: TriggerListItem,
  store: RunStore,
): Promise<TriggerListItem & { adapter_status: TriggerAdapterStatus }> {
  const adapter_status = await readTriggerAdapterStatus(item, store);
  return { ...item, adapter_status };
}

function resolveListedTrigger(
  items: TriggerListItem[],
  id: string,
  projectRootWire?: string,
):
  | TriggerListItem
  | { error: string; status: 404 | 409; project_roots?: string[] } {
  if (projectRootWire) {
    const found = items.find(
      (item) => item.id === id && item.project_root === projectRootWire,
    );
    if (!found) {
      return { error: `Trigger not found: ${id}`, status: 404 };
    }
    return found;
  }
  const matches = items.filter((item) => item.id === id);
  if (matches.length === 0) {
    return { error: `Trigger not found: ${id}`, status: 404 };
  }
  if (matches.length > 1) {
    return {
      error: `Trigger id is ambiguous across catalog roots: ${id}`,
      status: 409,
      project_roots: [...new Set(matches.map((m) => m.project_root))].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }
  return matches[0]!;
}

export type TriggerRoutesCtx = {
  cwd: string;
  manager: RunManager;
  store: RunStore;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  readRawBody: (req: IncomingMessage) => Promise<Buffer>;
  auditLog: Logger;
};

export async function handleTriggerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TriggerRoutesCtx,
): Promise<boolean> {
  const { cwd, manager, store, json, readJsonBody, readRawBody, auditLog } = ctx;
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (method === "POST" && pathname === "/api/triggers") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const writeRoot =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as { project_root?: unknown }).project_root === "string"
        ? (body as { project_root: string }).project_root
        : undefined;
    let triggerWriteRoot: string;
    try {
      const { wireRoot: selected } = await resolveWritableCatalogRoot(
        { store, bootCwd: cwd },
        writeRoot,
      );
      triggerWriteRoot = selected.path;
    } catch (err) {
      if (err instanceof CatalogPathError) {
        json(res, err.code === "catalog_root_read_only" ? 403 : 400, catalogPathErrorBody(err));
        return true;
      }
      throw err;
    }
    const parsed = parseCreateTriggerBody(body);
    if ("ok" in parsed) {
      json(res, parsed.status, { error: parsed.error });
      return true;
    }
    const stageflowCtx = await resolveStageflowContext(triggerWriteRoot);
    if (stageflowCtx.manifestStatus !== "ok") {
      json(res, 400, {
        error: "Project root not found; initialize stageflow.yaml",
      });
      return true;
    }
    const callerId = callerIdFromRequestAuth();
    const result = await createTrigger(stageflowCtx.projectRoot, parsed);
    if (!result.ok) {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "rest",
        action: "trigger_create",
        outcome: "error",
      });
      json(res, result.status, { error: result.error });
      return true;
    }
    writeAudit(auditLog, {
      caller_id: callerId,
      surface: getRequestAuth()?.surface ?? "rest",
      action: "trigger_create",
      outcome: "ok",
    });
    json(res, 201, result.trigger);
    return true;
  }

  if (method === "GET" && pathname === "/api/triggers") {
    const items = await loadCatalogTriggers({ store, bootCwd: cwd });
    const triggers = await Promise.all(items.map((item) => enrichTriggerListItem(item, store)));
    json(res, 200, { triggers });
    return true;
  }

  const fireMatch = pathname.match(/^\/api\/triggers\/([^/]+)\/fire$/);
  if (method === "POST" && fireMatch) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      // empty/invalid body ok
    }
    const rawTask =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { task?: unknown }).task
        : undefined;
    let task: TaskFile | undefined;
    if (rawTask !== undefined) {
      task = coerceTaskFile(rawTask);
      if (task === undefined) {
        json(res, 400, { error: "Invalid task: id and goal are required strings" });
        return true;
      }
    }
    const id = decodeURIComponent(fireMatch[1] ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const projectRootWire = url.searchParams.get("project_root") ?? undefined;
    const callerId = callerIdFromRequestAuth();
    const result = await fireTrigger(id, store, manager, {
      cwd,
      task,
      ...(projectRootWire ? { project_root: projectRootWire } : {}),
    });
    if (!result.ok) {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "rest",
        action: "trigger_fire",
        outcome: "error",
        error_code: result.code,
      });
      json(res, result.status ?? 500, mapStartFailure(result));
      return true;
    }
    writeAudit(auditLog, {
      caller_id: callerId,
      surface: getRequestAuth()?.surface ?? "rest",
      action: "trigger_fire",
      target_run_id: result.runId,
      outcome: "ok",
    });
    json(res, 202, {
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
    return true;
  }

  const webhookMatch = pathname.match(/^\/api\/triggers\/([^/]+)\/webhook$/);
  if (method === "POST" && webhookMatch) {
    const id = decodeURIComponent(webhookMatch[1] ?? "");
    const callerId = callerIdFromRequestAuth();

    const url = new URL(req.url ?? "/", "http://localhost");
    const projectRootWire = url.searchParams.get("project_root") ?? undefined;
    const located = await findCatalogTrigger({
      store,
      bootCwd: cwd,
      triggerId: id,
      ...(projectRootWire ? { projectRootFilter: projectRootWire } : {}),
    });
    if (!located.ok) {
      if (located.status === 409 && located.code === "ambiguous_trigger") {
        json(res, located.status, {
          error: located.reason,
          code: located.code,
          project_roots: located.project_roots,
        });
      } else if (located.status === 400 && located.code === "unknown_project_root") {
        json(res, located.status, {
          error: located.reason,
          code: located.code,
        });
      } else {
        json(res, located.status, { error: located.reason });
      }
      return true;
    }
    const rawBody = await readRawBody(req);
    const accepted = acceptWebhook({
      trigger: located.match.definition,
      rawBody,
      headers: req.headers,
      env: process.env,
    });
    if (accepted.kind === "not_configured") {
      json(res, 400, { error: "this trigger has no webhook signing configured" });
      return true;
    }
    if (accepted.kind === "bad_signature") {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: "webhook",
        action: "trigger_webhook",
        outcome: "error",
        error_code: "webhook.signature_invalid",
      });
      json(res, 401, { error: "Invalid webhook signature" });
      return true;
    }
    if (accepted.kind === "bad_json") {
      json(res, 400, { error: accepted.error });
      return true;
    }
    if (accepted.kind === "no_match") {
      json(res, 200, { fired: false });
      return true;
    }

    const result = await fireTrigger(id, store, manager, {
      cwd,
      task: accepted.task,
      project_root: located.match.project_root,
    });
    if (!result.ok) {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: "webhook",
        action: "trigger_webhook",
        outcome: "error",
        error_code: result.code,
      });
      json(res, result.status ?? 500, mapStartFailure(result));
      return true;
    }
    writeAudit(auditLog, {
      caller_id: callerId,
      surface: "webhook",
      action: "trigger_webhook",
      target_run_id: result.runId,
      outcome: "ok",
    });
    json(res, 201, {
      fired: true,
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
    return true;
  }

  const statusMatch = pathname.match(/^\/api\/triggers\/([^/]+)\/status$/);
  if (method === "GET" && statusMatch) {
    const id = decodeURIComponent(statusMatch[1] ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const projectRootWire = url.searchParams.get("project_root") ?? undefined;
    const items = await loadCatalogTriggers({ store, bootCwd: cwd });
    const found = resolveListedTrigger(items, id, projectRootWire);
    if ("error" in found) {
      json(res, found.status, { error: found.error, ...(found.project_roots ? { project_roots: found.project_roots } : {}) });
      return true;
    }
    const adapter_status = await readTriggerAdapterStatus(found, store);
    json(res, 200, adapter_status);
    return true;
  }

  const firesMatch = pathname.match(/^\/api\/triggers\/([^/]+)\/fires$/);
  if (method === "GET" && firesMatch) {
    const id = decodeURIComponent(firesMatch[1] ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const projectRootWire = url.searchParams.get("project_root") ?? undefined;
    const items = await loadCatalogTriggers({ store, bootCwd: cwd });
    const found = resolveListedTrigger(items, id, projectRootWire);
    if ("error" in found) {
      json(res, found.status, { error: found.error, ...(found.project_roots ? { project_roots: found.project_roots } : {}) });
      return true;
    }
    const fires = await store.listTriggerFires(
      triggerStoreId(found.project_root, found.id),
      20,
    );
    json(res, 200, { fires });
    return true;
  }

  const putMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
  if (method === "PUT" && putMatch) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const id = decodeURIComponent(putMatch[1] ?? "");
    const parsed = parsePutTriggerBody(body, id);
    if ("ok" in parsed) {
      json(res, parsed.status, { error: parsed.error });
      return true;
    }
    const projectRootFilter = projectRootFilterFromBody(body);
    const callerId = callerIdFromRequestAuth();
    const result = await updateTriggerDefinition(cwd, store, id, parsed, {
      projectRootFilter,
    });
    if (!result.ok) {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "rest",
        action: "trigger_update",
        outcome: "error",
      });
      json(res, result.status, { error: result.error });
      return true;
    }
    writeAudit(auditLog, {
      caller_id: callerId,
      surface: getRequestAuth()?.surface ?? "rest",
      action: "trigger_update",
      outcome: "ok",
    });
    const enriched = await enrichTriggerListItem(result.trigger, store);
    json(res, 200, enriched);
    return true;
  }

  const patchMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
  if (method === "PATCH" && patchMatch) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const parsed = parsePatchTriggerBody(body);
    if ("ok" in parsed) {
      json(res, parsed.status, { error: parsed.error });
      return true;
    }
    const id = decodeURIComponent(patchMatch[1] ?? "");
    const projectRootFilter = projectRootFilterFromBody(body);
    const callerId = callerIdFromRequestAuth();
    const result = await updateTriggerEnabled(cwd, store, id, parsed.enabled, {
      projectRootFilter,
    });
    if (!result.ok) {
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "rest",
        action: "trigger_patch",
        outcome: "error",
      });
      json(res, result.status, { error: result.error });
      return true;
    }
    writeAudit(auditLog, {
      caller_id: callerId,
      surface: getRequestAuth()?.surface ?? "rest",
      action: "trigger_patch",
      outcome: "ok",
    });
    const enriched = await enrichTriggerListItem(result.trigger, store);
    json(res, 200, enriched);
    return true;
  }

  const idMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
  if (method === "GET" && idMatch) {
    const id = decodeURIComponent(idMatch[1] ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const projectRootWire = url.searchParams.get("project_root") ?? undefined;
    const items = await loadCatalogTriggers({ store, bootCwd: cwd });
    const found = resolveListedTrigger(items, id, projectRootWire);
    if ("error" in found) {
      json(res, found.status, { error: found.error, ...(found.project_roots ? { project_roots: found.project_roots } : {}) });
      return true;
    }
    json(res, 200, await enrichTriggerListItem(found, store));
    return true;
  }

  return false;
}
