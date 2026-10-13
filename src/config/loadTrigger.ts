import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { TriggerEvent, TriggerFile, TriggerSchedule } from "../types/trigger.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import { yamlParsePosition } from "./yamlParsePosition.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSchedule(raw: unknown): TriggerSchedule | undefined {
  if (!isPlainObject(raw) || typeof raw.cron !== "string") return undefined;
  return {
    cron: raw.cron,
    ...(typeof raw.timezone === "string" ? { timezone: raw.timezone } : {}),
  };
}

function parseEvent(raw: unknown): TriggerEvent | undefined {
  if (!isPlainObject(raw) || typeof raw.source !== "string") return undefined;
  return {
    source: raw.source,
    ...(isPlainObject(raw.match) ? { match: raw.match } : {}),
    ...(isPlainObject(raw.config) ? { config: raw.config } : {}),
  };
}

/** Structural TriggerFile shape only. */
export function coerceTriggerFile(raw: unknown): TriggerFile | undefined {
  const record = raw as Record<string, unknown> | null | undefined;
  if (
    typeof record?.id !== "string" ||
    typeof record?.pipeline !== "string" ||
    typeof record?.enabled !== "boolean"
  ) {
    return undefined;
  }
  if (record.task !== undefined && typeof record.task !== "string") {
    return undefined;
  }
  if (record.kind !== "manual" && record.kind !== "schedule" && record.kind !== "event") {
    return undefined;
  }

  let schedule: TriggerSchedule | undefined;
  if (record.schedule !== undefined) {
    schedule = parseSchedule(record.schedule);
    if (schedule === undefined) return undefined;
  }

  let event: TriggerEvent | undefined;
  if (record.event !== undefined) {
    event = parseEvent(record.event);
    if (event === undefined) return undefined;
  }

  return {
    id: record.id,
    pipeline: record.pipeline,
    kind: record.kind,
    enabled: record.enabled,
    ...(typeof record.task === "string" ? { task: record.task } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(event !== undefined ? { event } : {}),
  };
}

export function parseTriggerFile(raw: unknown, source = "trigger"): LoadOutcome<TriggerFile> {
  const record = raw as Record<string, unknown> | null | undefined;
  const trigger = coerceTriggerFile(raw);
  if (trigger === undefined) {
    return loadFailure([
      {
        code: "trigger.invalid_shape",
        message: `Invalid ${source}: id, pipeline, kind, and enabled are required`,
        category: "trigger",
        triggerId: typeof record?.id === "string" ? record.id : undefined,
      },
    ]);
  }

  return loadSuccess(trigger);
}

export function loadTriggerFromYamlOutcome(
  yamlText: string,
  source = "trigger yaml",
): LoadOutcome<TriggerFile> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "trigger.load_error",
        message,
        category: "trigger",
        ...yamlParsePosition(err),
      },
    ]);
  }
  return parseTriggerFile(raw, source);
}

export async function loadTriggerOutcome(filePath: string): Promise<LoadOutcome<TriggerFile>> {
  let yamlText: string;
  try {
    yamlText = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "trigger.load_error",
        message,
        category: "trigger",
      },
    ]);
  }
  return loadTriggerFromYamlOutcome(yamlText, `trigger file ${filePath}`);
}

export function loadTriggerFromYaml(
  yamlText: string,
  source = "trigger yaml",
): TriggerFile {
  const outcome = loadTriggerFromYamlOutcome(yamlText, source);
  if (!outcome.ok) throw new Error(outcome.issues[0].message);
  return outcome.value;
}

export async function loadTrigger(filePath: string): Promise<TriggerFile> {
  const outcome = await loadTriggerOutcome(filePath);
  if (!outcome.ok) throw new Error(outcome.issues[0].message);
  return outcome.value;
}
