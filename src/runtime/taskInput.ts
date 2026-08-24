import { stringify as stringifyYaml } from "yaml";
import { parseTaskFile } from "../config/loadTask.js";
import type { TaskFile } from "../types/task.js";
import { resolveTaskPath } from "./pipelineRunner.js";

export type StartTaskInput = {
  task?: string | TaskFile;
  taskYaml?: string;
};

export type ResolvedTaskInput =
  | { kind: "path"; taskPath: string }
  | { kind: "yaml"; taskYaml: string };

export function isTaskFile(value: unknown): value is TaskFile {
  return parseTaskFile(value, "task").ok;
}

export function taskFileToYaml(task: TaskFile): string {
  const doc: Record<string, string> = {
    id: task.id,
    goal: task.goal,
  };
  if (task.context !== undefined) doc.context = task.context;
  if (task.constraints !== undefined) doc.constraints = task.constraints;
  if (task.checkout !== undefined) doc.checkout = task.checkout;
  return stringifyYaml(doc);
}

export function resolveStartTaskInput(
  input: StartTaskInput,
  cwd: string,
): ResolvedTaskInput {
  if (typeof input.taskYaml === "string") {
    if (input.taskYaml.trim().length === 0) {
      throw new Error("taskYaml must be a non-empty string");
    }
    return { kind: "yaml", taskYaml: input.taskYaml };
  }

  if (typeof input.task === "string") {
    if (input.task.trim().length === 0) {
      throw new Error("task path must be a non-empty string");
    }
    return { kind: "path", taskPath: resolveTaskPath(input.task, cwd) };
  }

  const parsed = parseTaskFile(input.task, "task");
  if (parsed.ok) {
    return { kind: "yaml", taskYaml: taskFileToYaml(parsed.value) };
  }

  throw new Error("task path, task object, or taskYaml is required");
}
