import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseTaskFile } from "../config/loadTask.js";
import { relPath, type ValidationFinding } from "../config/validateCatalog.js";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import type { LoadedPipeline } from "../types/pipeline.js";
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
  const doc: Record<string, unknown> = {
    id: task.id,
    goal: task.goal,
  };
  if (task.context !== undefined) doc.context = task.context;
  if (task.constraints !== undefined) doc.constraints = task.constraints;
  if (task.checkout !== undefined) doc.checkout = task.checkout;
  if (task.input !== undefined) doc.input = task.input;
  return stringifyYaml(doc);
}

/** Validate optional `task.input` against entry-stage IR `clone_input_schema` (YAML: `io.input.schema`). */
export function checkTaskEntryInput(
  task: TaskFile,
  loaded: LoadedPipeline,
  options: { cwd: string; taskPath?: string },
): ValidationFinding[] {
  const absPath = options.taskPath
    ? path.resolve(options.cwd, options.taskPath)
    : path.resolve(options.cwd, "task.yaml");
  const findingPath = relPath(options.cwd, absPath);
  const stageById = new Map(loaded.stages.map((stage) => [stage.id, stage]));
  const findings: ValidationFinding[] = [];

  for (const rootId of loaded.dag.roots) {
    const stage = stageById.get(rootId);
    if (stage?.clone_input_schema === undefined) continue;
    if (task.input === undefined) {
      findings.push({
        severity: "warning",
        code: "task.entry_input_unmet",
        path: findingPath,
        message: `Task has no input; entry stage "${rootId}" requires io.input`,
        category: "task",
        pipelineId: loaded.pipeline.id,
        stageId: rootId,
      });
      continue;
    }
    let details: string | undefined;
    try {
      details = payloadInstanceMismatch(task.input, stage.clone_input_schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        severity: "error",
        code: "task.invalid_shape",
        path: findingPath,
        message: `Task input does not match entry stage "${rootId}" io.input: ${message}`,
        category: "task",
        pipelineId: loaded.pipeline.id,
        stageId: rootId,
      });
      continue;
    }
    if (details !== undefined) {
      findings.push({
        severity: "error",
        code: "task.invalid_shape",
        path: findingPath,
        message: `Task input does not match entry stage "${rootId}" io.input: ${details}`,
        category: "task",
        pipelineId: loaded.pipeline.id,
        stageId: rootId,
      });
    }
  }
  return findings;
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
