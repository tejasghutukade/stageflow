import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { TaskFile } from "../types/task.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

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
  return loadSuccess({
    id: record.id,
    goal: record.goal,
    context: typeof record.context === "string" ? record.context : undefined,
    constraints: typeof record.constraints === "string" ? record.constraints : undefined,
    checkout: typeof record.checkout === "string" ? record.checkout : undefined,
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
