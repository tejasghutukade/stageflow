import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { CheckoutDescriptor, TaskFile } from "../types/task.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheckout(value: unknown): CheckoutDescriptor | undefined {
  if (typeof value === "string") return value;
  if (isPlainObject(value)) {
    const branch = typeof value.branch === "string" ? value.branch : undefined;
    const base = typeof value.base === "string" ? value.base : undefined;
    return { ...(branch !== undefined ? { branch } : {}), ...(base !== undefined ? { base } : {}) };
  }
  return undefined;
}

export function parseTaskFile(raw: unknown, source = "task"): LoadOutcome<TaskFile> {
  const record = raw as Record<string, unknown> | null | undefined;
  if (typeof record?.id !== "string" || typeof record?.goal !== "string") {
    return loadFailure([
      {
        code: "task.invalid_shape",
        message: `Invalid ${source}: id and goal are required strings`,
        category: "task",
        taskId: typeof record?.id === "string" ? record.id : undefined,
      },
    ]);
  }
  if (record.input !== undefined && !isPlainObject(record.input)) {
    return loadFailure([
      {
        code: "task.invalid_shape",
        message: `Invalid ${source}: input must be an object`,
        category: "task",
        taskId: record.id,
      },
    ]);
  }
  if (isPlainObject(record.checkout)) {
    const { branch, base } = record.checkout;
    if (branch !== undefined && typeof branch !== "string") {
      return loadFailure([
        {
          code: "task.invalid_shape",
          message: `Invalid ${source}: checkout.branch must be a string`,
          category: "task",
          taskId: record.id,
        },
      ]);
    }
    if (base !== undefined && typeof base !== "string") {
      return loadFailure([
        {
          code: "task.invalid_shape",
          message: `Invalid ${source}: checkout.base must be a string`,
          category: "task",
          taskId: record.id,
        },
      ]);
    }
  }
  return loadSuccess({
    id: record.id,
    goal: record.goal,
    context: typeof record.context === "string" ? record.context : undefined,
    constraints: typeof record.constraints === "string" ? record.constraints : undefined,
    checkout: parseCheckout(record.checkout),
    ...(record.input !== undefined ? { input: record.input } : {}),
  });
}

export function loadTaskFromYamlOutcome(
  yamlText: string,
  source = "task yaml",
): LoadOutcome<TaskFile> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "task.load_error",
        message,
        category: "task",
      },
    ]);
  }
  return parseTaskFile(raw, source);
}

export async function loadTaskOutcome(filePath: string): Promise<LoadOutcome<TaskFile>> {
  let yamlText: string;
  try {
    yamlText = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "task.load_error",
        message,
        category: "task",
      },
    ]);
  }
  return loadTaskFromYamlOutcome(yamlText, `task file ${filePath}`);
}

export function loadTaskFromYaml(
  yamlText: string,
  source = "task yaml",
): TaskFile {
  const outcome = loadTaskFromYamlOutcome(yamlText, source);
  if (!outcome.ok) throw new Error(outcome.issues[0].message);
  return outcome.value;
}

export async function loadTask(filePath: string): Promise<TaskFile> {
  const outcome = await loadTaskOutcome(filePath);
  if (!outcome.ok) throw new Error(outcome.issues[0].message);
  return outcome.value;
}
