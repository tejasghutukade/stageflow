import { access, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { TaskFile } from "../types/task.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { STAGE_ID_PATTERN } from "./createStage.js";
import type { TaskDetail } from "./findTaskInCatalog.js";
import { loadTaskOutcome } from "./loadTask.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

const OPTIONAL_KEYS = ["context", "constraints", "checkout", "repository", "ref"] as const;

type OptionalKey = (typeof OPTIONAL_KEYS)[number];

export type CreateTaskInput = {
  directory: string;
  id: string;
  goal: string;
  context?: string;
  constraints?: string;
  checkout?: string;
  repository?: string;
  ref?: string;
};

export type CreateTaskParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type CreateTaskResult =
  | { ok: true; task: TaskDetail }
  | { ok: false; status: 400 | 404 | 409 | 500 | 502; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateTaskId(id: string): string | null {
  if (id.length === 0 || id.length > 64) {
    return "id must be 1-64 characters";
  }
  if (!STAGE_ID_PATTERN.test(id)) {
    return "id must be lowercase kebab-case";
  }
  return null;
}

function optionalCreateString(
  body: Record<string, unknown>,
  key: OptionalKey,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) {
    return { ok: true };
  }
  if (typeof body[key] !== "string") {
    return { ok: false, error: `${key} must be a string` };
  }
  if (body[key].length === 0) return { ok: true };
  return { ok: true, value: body[key] };
}

export function parseCreateTaskBody(body: unknown): CreateTaskInput | CreateTaskParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  if (typeof body.directory !== "string" || body.directory.trim().length === 0) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  const directory = body.directory.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (directory.length === 0) {
    return { ok: false, status: 400, error: "directory is required" };
  }
  if (typeof body.id !== "string") {
    return { ok: false, status: 400, error: "id is required" };
  }
  const idError = validateTaskId(body.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }
  if (typeof body.goal !== "string" || body.goal.length === 0) {
    return { ok: false, status: 400, error: "goal is required" };
  }

  const input: CreateTaskInput = {
    directory,
    id: body.id,
    goal: body.goal,
  };
  for (const key of OPTIONAL_KEYS) {
    const parsed = optionalCreateString(body, key);
    if (!parsed.ok) {
      return { ok: false, status: 400, error: parsed.error };
    }
    if (parsed.value !== undefined) input[key] = parsed.value;
  }
  return input;
}

export function resolveTaskDirectory(projectRoot: string, directory: string): string | null {
  const absDirectory = path.resolve(projectRoot, directory);
  const rel = path.relative(projectRoot, absDirectory);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return absDirectory;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function taskFieldsToYaml(fields: CreateTaskInput): string {
  const doc: Record<string, unknown> = {
    id: fields.id,
    goal: fields.goal,
  };
  for (const key of OPTIONAL_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) doc[key] = value;
  }
  const text = stringifyYaml(doc, { indent: 2, lineWidth: 0 });
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function findTaskIdCollision(
  projectRoot: string,
  id: string,
  targetPath: string,
): Promise<string | null> {
  if (await fileExists(targetPath)) {
    return path.relative(projectRoot, targetPath).replace(/\\/g, "/");
  }
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(projectRoot));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) return null;
  const resolvedTarget = path.resolve(targetPath);
  for (const filePath of scanPaths.taskPaths) {
    if (path.resolve(filePath) === resolvedTarget) continue;
    const outcome = await loadTaskOutcome(filePath);
    if (outcome.ok && outcome.value.id === id) {
      return path.relative(projectRoot, filePath).replace(/\\/g, "/");
    }
  }
  return null;
}

function taskDetail(task: TaskFile, projectRoot: string, filePath: string): TaskDetail {
  return {
    ...task,
    path: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
  };
}

export async function createTask(
  rawProjectRoot: string,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const idError = validateTaskId(input.id);
  if (idError) {
    return { ok: false, status: 400, error: idError };
  }
  const projectRoot = await realpath(rawProjectRoot).catch(() => rawProjectRoot);
  const directory = resolveTaskDirectory(projectRoot, input.directory);
  if (!directory) {
    return { ok: false, status: 400, error: "directory must be inside the project root" };
  }

  const filePath = path.join(directory, `${input.id}.task.yaml`);
  const collision = await findTaskIdCollision(projectRoot, input.id, filePath);
  if (collision) {
    const targetRel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
    const error =
      collision === targetRel
        ? `Task file already exists (${collision})`
        : `Task id already exists (${collision})`;
    return { ok: false, status: 409, error };
  }

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, taskFieldsToYaml(input), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }

  const outcome = await loadTaskOutcome(filePath);
  if (!outcome.ok) {
    await unlink(filePath).catch(() => {});
    return {
      ok: false,
      status: 400,
      error: outcome.issues[0]?.message ?? "Invalid task",
    };
  }
  return { ok: true, task: taskDetail(outcome.value, projectRoot, filePath) };
}
