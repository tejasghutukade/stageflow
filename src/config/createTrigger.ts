import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { stringify as stringifyYaml } from "yaml";
import type { TriggerEvent, TriggerSchedule } from "../types/trigger.js";
import { STAGE_ID_PATTERN } from "./createStage.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { loadTriggerOutcome } from "./loadTrigger.js";
import { collectPipelineIdsFromPaths, collectTaskIdsFromPaths } from "./validateCatalog.js";
import { findCatalogPathById } from "../runtime/triggerCatalog.js";
import type { TriggerListItem } from "./triggerCatalog.js";

export type CreateTriggerInput = {
  directory: string;
  id: string;
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
  enabled?: boolean;
};

export type CreateTriggerParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type CreateTriggerResult =
  | { ok: true; trigger: TriggerListItem }
  | { ok: false; status: 400 | 409 | 422 | 500; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTriggerId(id: string): string | null {
  if (id.length === 0 || id.length > 64) {
    return "id must be 1-64 characters";
  }
  if (!STAGE_ID_PATTERN.test(id)) {
    return "id must be lowercase kebab-case";
  }
  return null;
}

type ParsedField<T> = { ok: true; value: T | undefined } | { ok: false; message: string };

function parseScheduleField(raw: unknown): ParsedField<TriggerSchedule> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, message: "schedule must be an object" };
  }
  if (typeof raw.cron !== "string" || raw.cron.trim().length === 0) {
    return { ok: false, message: "schedule.cron is required" };
  }
  if (raw.timezone !== undefined && typeof raw.timezone !== "string") {
    return { ok: false, message: "schedule.timezone must be a string" };
  }
  return {
    ok: true,
    value: {
      cron: raw.cron,
      ...(typeof raw.timezone === "string" ? { timezone: raw.timezone } : {}),
    },
  };
}

function parseEventField(raw: unknown): ParsedField<TriggerEvent> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, message: "event must be an object" };
  }
  if (typeof raw.source !== "string" || raw.source.trim().length === 0) {
    return { ok: false, message: "event.source is required" };
  }
  if (raw.match !== undefined && !isPlainObject(raw.match)) {
    return { ok: false, message: "event.match must be an object" };
  }
  return {
    ok: true,
    value: {
      source: raw.source,
      ...(isPlainObject(raw.match) ? { match: raw.match } : {}),
    },
  };
}

export function parseCreateTriggerBody(
  body: unknown,
): CreateTriggerInput | CreateTriggerParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  if (typeof body.directory !== "string" || !body.directory.trim()) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  const directory = body.directory.trim().replace(/\\/g, "/");

  if (typeof body.id !== "string") {
    return { ok: false, status: 400, error: "id is required" };
  }
  const idError = validateTriggerId(body.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }

  if (typeof body.pipeline !== "string" || !body.pipeline.trim()) {
    return { ok: false, status: 400, error: "pipeline is required" };
  }
  if (body.task !== undefined && (typeof body.task !== "string" || !body.task.trim())) {
    return { ok: false, status: 400, error: "task must be a non-empty string" };
  }

  if (body.kind !== "manual" && body.kind !== "schedule" && body.kind !== "event") {
    return {
      ok: false,
      status: 400,
      error: "kind must be one of: manual, schedule, event",
    };
  }

  const schedule = parseScheduleField(body.schedule);
  if (!schedule.ok) {
    return { ok: false, status: 400, error: schedule.message };
  }
  const event = parseEventField(body.event);
  if (!event.ok) {
    return { ok: false, status: 400, error: event.message };
  }

  if (body.kind === "schedule" && schedule.value === undefined) {
    return { ok: false, status: 400, error: "schedule.cron is required for kind=schedule" };
  }
  if (body.kind === "event" && event.value === undefined) {
    return { ok: false, status: 400, error: "event.source is required for kind=event" };
  }

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }

  return {
    directory,
    id: body.id,
    pipeline: body.pipeline,
    ...(typeof body.task === "string" ? { task: body.task } : {}),
    kind: body.kind,
    ...(schedule.value !== undefined ? { schedule: schedule.value } : {}),
    ...(event.value !== undefined ? { event: event.value } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  };
}

function resolveDirectory(projectRoot: string, directory: string): string | null {
  const absDirectory = path.resolve(projectRoot, directory);
  const rel = path.relative(projectRoot, absDirectory);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return absDirectory;
}

function triggerInputToYaml(input: CreateTriggerInput, enabled: boolean): string {
  const doc: Record<string, unknown> = {
    id: input.id,
    pipeline: input.pipeline,
    ...(input.task !== undefined ? { task: input.task } : {}),
    kind: input.kind,
  };
  if (input.kind === "schedule" && input.schedule) {
    doc.schedule = input.schedule;
  }
  if (input.kind === "event" && input.event) {
    doc.event = input.event;
  }
  doc.enabled = enabled;
  return stringifyYaml(doc);
}

export async function createTrigger(
  rawProjectRoot: string,
  input: CreateTriggerInput,
): Promise<CreateTriggerResult> {
  const idError = validateTriggerId(input.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }

  const projectRoot = await realpath(rawProjectRoot).catch(() => rawProjectRoot);

  const directory = resolveDirectory(projectRoot, input.directory);
  if (!directory) {
    return { ok: false, status: 400, error: "directory must be inside the project root" };
  }

  const ctx = catalogContextFromStageflow(await resolveStageflowContext(projectRoot));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return {
      ok: false,
      status: 422,
      error: "Catalog manifest not found; cannot validate trigger references",
    };
  }

  const collisionPath = await findCatalogPathById(scanPaths.triggerPaths, input.id);
  if (collisionPath) {
    return {
      ok: false,
      status: 409,
      error: `Trigger id already exists (${path.relative(projectRoot, collisionPath).replace(/\\/g, "/")})`,
    };
  }

  const pipelineIds = await collectPipelineIdsFromPaths(scanPaths.pipelinePaths);
  if (!pipelineIds.has(input.pipeline)) {
    return {
      ok: false,
      status: 422,
      error: `Trigger references unknown pipeline "${input.pipeline}"`,
    };
  }

  if (input.task !== undefined) {
    const taskIds = await collectTaskIdsFromPaths(scanPaths.taskPaths);
    if (!taskIds.has(input.task)) {
      return {
        ok: false,
        status: 422,
        error: `Trigger references unknown task "${input.task}"`,
      };
    }
  }

  if (input.kind === "schedule") {
    if (!input.schedule) {
      return { ok: false, status: 422, error: "schedule.cron is required for kind=schedule" };
    }
    try {
      new Cron(
        input.schedule.cron,
        input.schedule.timezone !== undefined ? { timezone: input.schedule.timezone } : {},
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 422, error: `Invalid schedule.cron: ${message}` };
    }
  }

  const filePath = path.join(directory, `${input.id}.trigger.yaml`);
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
  const enabled = input.enabled ?? true;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, triggerInputToYaml(input, enabled), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  const loadOutcome = await loadTriggerOutcome(filePath);
  if (!loadOutcome.ok) {
    await unlink(filePath).catch(() => {});
    return {
      ok: false,
      status: 500,
      error: loadOutcome.issues[0]?.message ?? "Failed to load created trigger",
    };
  }

  return {
    ok: true,
    trigger: {
      ...loadOutcome.value,
      definition_ref: relPath,
    },
  };
}
