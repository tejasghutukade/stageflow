import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { RunStore } from "../runstore/port.js";
import type { TriggerEvent, TriggerSchedule } from "../types/trigger.js";
import { loadCatalogTriggers, type TriggerListItem } from "./triggerCatalog.js";
import { loadTriggerFromYamlOutcome } from "./loadTrigger.js";
import { findTriggerDefinition } from "../runtime/triggerCatalog.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import {
  parseEventField,
  parseScheduleField,
  scheduleCronError,
  triggerReferenceError,
} from "./createTrigger.js";

export type PatchTriggerInput = {
  enabled: boolean;
};

export type PatchTriggerParseError = {
  ok: false;
  status: 400;
  error: string;
};

export function parsePatchTriggerBody(
  body: unknown,
): PatchTriggerInput | PatchTriggerParseError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "enabled") {
    return {
      ok: false,
      status: 400,
      error: "Only enabled is allowed in the request body",
    };
  }
  if (typeof record.enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }
  return { enabled: record.enabled };
}

export type PutTriggerInput = {
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
  enabled: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePutTriggerBody(
  body: unknown,
  triggerId: string,
): PutTriggerInput | PatchTriggerParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  if ("id" in body && body.id !== triggerId) {
    return { ok: false, status: 400, error: "id cannot be changed" };
  }
  if (typeof body.pipeline !== "string" || !body.pipeline.trim()) {
    return { ok: false, status: 400, error: "pipeline is required" };
  }
  if (
    body.task !== undefined &&
    body.task !== null &&
    (typeof body.task !== "string" || !body.task.trim())
  ) {
    return { ok: false, status: 400, error: "task must be a non-empty string" };
  }
  if (body.kind !== "manual" && body.kind !== "schedule" && body.kind !== "event") {
    return {
      ok: false,
      status: 400,
      error: "kind must be one of: manual, schedule, event",
    };
  }

  const scheduleRaw =
    body.kind === "schedule" ? (body.schedule === null ? undefined : body.schedule) : undefined;
  const eventRaw =
    body.kind === "event" ? (body.event === null ? undefined : body.event) : undefined;
  const schedule = parseScheduleField(scheduleRaw);
  if (!schedule.ok) {
    return { ok: false, status: 400, error: schedule.message };
  }
  const event = parseEventField(eventRaw);
  if (!event.ok) {
    return { ok: false, status: 400, error: event.message };
  }
  if (body.kind === "schedule" && schedule.value === undefined) {
    return { ok: false, status: 400, error: "schedule.cron is required for kind=schedule" };
  }
  if (body.kind === "event" && event.value === undefined) {
    return { ok: false, status: 400, error: "event.source is required for kind=event" };
  }
  if (typeof body.enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }

  return {
    pipeline: body.pipeline,
    ...(typeof body.task === "string" ? { task: body.task } : {}),
    kind: body.kind,
    ...(schedule.value !== undefined ? { schedule: schedule.value } : {}),
    ...(event.value !== undefined ? { event: event.value } : {}),
    enabled: body.enabled,
  };
}

export type UpdateTriggerResult =
  | { ok: true; trigger: TriggerListItem }
  | { ok: false; status: 404 | 400 | 422 | 500; error: string };

export async function updateTriggerEnabled(
  cwd: string,
  store: RunStore,
  triggerId: string,
  enabled: boolean,
): Promise<UpdateTriggerResult> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return { ok: false, status: 404, error: "No Stageflow catalog found" };
  }

  const found = await findTriggerDefinition(scanPaths.triggerPaths, triggerId);
  if (!found) {
    return { ok: false, status: 404, error: `Trigger not found: ${triggerId}` };
  }

  const yamlText = await readFile(found.path, "utf8");
  const doc = parseDocument(yamlText);
  if (!doc.contents || typeof doc.contents !== "object") {
    return { ok: false, status: 500, error: "Trigger YAML must be an object" };
  }
  doc.set("enabled", enabled);
  const patched = doc.toString();
  const loadOutcome = loadTriggerFromYamlOutcome(patched, found.path);
  if (!loadOutcome.ok) {
    return {
      ok: false,
      status: 400,
      error: loadOutcome.issues[0]?.message ?? "Invalid trigger after patch",
    };
  }

  await writeFile(found.path, patched, "utf8");

  const projectRoot = ctx.projectRoot ?? undefined;
  const definitionRef =
    projectRoot !== undefined
      ? path.relative(projectRoot, found.path).replace(/\\/g, "/")
      : found.path;
  await store.upsertTrigger({
    id: loadOutcome.value.id,
    definitionRef,
    enabled: loadOutcome.value.enabled,
  });

  const items = await loadCatalogTriggers(cwd, store);
  const item = items?.find((row) => row.id === triggerId);
  if (!item) {
    return { ok: false, status: 500, error: "Trigger updated but not listed" };
  }
  return { ok: true, trigger: item };
}

export async function updateTriggerDefinition(
  cwd: string,
  store: RunStore,
  triggerId: string,
  input: PutTriggerInput,
): Promise<UpdateTriggerResult> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return { ok: false, status: 404, error: "No Stageflow catalog found" };
  }

  const found = await findTriggerDefinition(scanPaths.triggerPaths, triggerId);
  if (!found) {
    return { ok: false, status: 404, error: `Trigger not found: ${triggerId}` };
  }

  const refError = await triggerReferenceError(scanPaths, input.pipeline, input.task);
  if (refError) {
    return { ok: false, status: 422, error: refError };
  }

  if (input.kind === "schedule") {
    if (!input.schedule) {
      return { ok: false, status: 422, error: "schedule.cron is required for kind=schedule" };
    }
    const cronError = scheduleCronError(input.schedule);
    if (cronError) {
      return { ok: false, status: 422, error: cronError };
    }
  }

  const yamlText = await readFile(found.path, "utf8");
  const doc = parseDocument(yamlText);
  if (!doc.contents || typeof doc.contents !== "object") {
    return { ok: false, status: 500, error: "Trigger YAML must be an object" };
  }

  doc.set("pipeline", input.pipeline);
  if (input.task !== undefined) doc.set("task", input.task);
  else doc.delete("task");
  doc.set("kind", input.kind);
  if (input.kind === "schedule" && input.schedule) {
    doc.delete("event");
    doc.set("schedule", {
      cron: input.schedule.cron,
      ...(input.schedule.timezone !== undefined ? { timezone: input.schedule.timezone } : {}),
    });
  } else if (input.kind === "event" && input.event) {
    doc.delete("schedule");
    doc.set("event", {
      source: input.event.source,
      ...(input.event.match !== undefined ? { match: input.event.match } : {}),
      ...(input.event.config !== undefined ? { config: input.event.config } : {}),
    });
  } else {
    doc.delete("schedule");
    doc.delete("event");
  }
  doc.set("enabled", input.enabled);

  const patched = doc.toString();
  const loadOutcome = loadTriggerFromYamlOutcome(patched, found.path);
  if (!loadOutcome.ok) {
    return {
      ok: false,
      status: 400,
      error: loadOutcome.issues[0]?.message ?? "Invalid trigger after update",
    };
  }

  await writeFile(found.path, patched, "utf8");

  const projectRoot = ctx.projectRoot ?? undefined;
  const definitionRef =
    projectRoot !== undefined
      ? path.relative(projectRoot, found.path).replace(/\\/g, "/")
      : found.path;
  await store.upsertTrigger({
    id: loadOutcome.value.id,
    definitionRef,
    enabled: loadOutcome.value.enabled,
  });

  const items = await loadCatalogTriggers(cwd, store);
  const item = items?.find((row) => row.id === triggerId);
  if (!item) {
    return { ok: false, status: 500, error: "Trigger updated but not listed" };
  }
  return { ok: true, trigger: item };
}
