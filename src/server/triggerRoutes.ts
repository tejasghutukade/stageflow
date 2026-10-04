import type { IncomingMessage, ServerResponse } from "node:http";
import { fireTrigger } from "../runtime/triggerRunner.js";
import { findTriggerDefinition } from "../runtime/triggerCatalog.js";
import { matchesEventFilter } from "../runtime/triggerEventMatch.js";
import { verifyHmacSignature } from "../runtime/webhookSignature.js";
import { mapStartFailure } from "./operatorResults.js";
import { writeAudit } from "../logging/audit.js";
import type { Logger } from "../logging/logger.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "./requestAuthContext.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunStore } from "../runstore/port.js";
import { loadCatalogTriggers } from "../config/triggerCatalog.js";
import { createTrigger, parseCreateTriggerBody } from "../config/createTrigger.js";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveWritableCatalogRoot,
} from "../config/catalogRelativePath.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { catalogContextFromStageflow } from "../config/resolveCatalogContext.js";
import { getCatalogScanPaths } from "../config/browseCatalog.js";
import { readSecretFromEnvOrFile } from "../config/secretFromEnvOrFile.js";
import { coerceTaskFile } from "../config/loadTask.js";
import type { TaskFile } from "../types/task.js";
export type { TriggerListItem } from "../config/triggerCatalog.js";

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
    const items = await loadCatalogTriggers(cwd, store);
    if (items === undefined) {
      json(res, 404, { error: "No Stageflow catalog found" });
      return true;
    }
    json(res, 200, { triggers: items });
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
    const callerId = callerIdFromRequestAuth();
    const result = await fireTrigger(id, store, manager, { cwd, task });
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

    const catalogCtx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
    const scanPaths = await getCatalogScanPaths(catalogCtx);
    const found = scanPaths
      ? await findTriggerDefinition(scanPaths.triggerPaths, id)
      : undefined;
    if (!found) {
      json(res, 404, { error: `Trigger not found: ${id}` });
      return true;
    }
    const { definition: trigger } = found;

    const config = trigger.event?.config;
    const secretRef = typeof config?.secretRef === "string" ? config.secretRef : undefined;
    const header = typeof config?.header === "string" ? config.header : undefined;
    if (secretRef === undefined || header === undefined) {
      json(res, 400, { error: "this trigger has no webhook signing configured" });
      return true;
    }
    const scheme = config?.scheme === "base64" ? "base64" : "hex";

    let secret: string | undefined;
    try {
      secret = readSecretFromEnvOrFile(process.env, secretRef);
    } catch {
      secret = undefined;
    }
    if (secret === undefined) {
      json(res, 400, { error: "this trigger has no webhook signing configured" });
      return true;
    }

    const rawBody = await readRawBody(req);
    const headerValue = req.headers[header.toLowerCase()];
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (
      typeof signature !== "string" ||
      signature.length === 0 ||
      !verifyHmacSignature(rawBody, signature, secret, scheme)
    ) {
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

    let payload: unknown;
    try {
      payload = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString("utf8"));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      json(res, 400, { error: "Invalid JSON body: expected an object" });
      return true;
    }
    const payloadRecord = payload as Record<string, unknown>;

    if (!matchesEventFilter(trigger.event?.match, payloadRecord)) {
      json(res, 200, { fired: false });
      return true;
    }

    const task: TaskFile | undefined =
      trigger.task === undefined
        ? {
            id: `${id}-webhook-${Date.now()}`,
            goal: `Handle webhook event for trigger "${id}"`,
            input: payloadRecord,
          }
        : undefined;

    const result = await fireTrigger(id, store, manager, { cwd, task });
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

  const idMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
  if (method === "GET" && idMatch) {
    const id = decodeURIComponent(idMatch[1] ?? "");
    const items = await loadCatalogTriggers(cwd, store);
    if (items === undefined) {
      json(res, 404, { error: "No Stageflow catalog found" });
      return true;
    }
    const found = items.find((item) => item.id === id);
    if (!found) {
      json(res, 404, { error: `Trigger not found: ${id}` });
      return true;
    }
    json(res, 200, found);
    return true;
  }

  return false;
}
