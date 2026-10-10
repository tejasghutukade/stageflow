import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { findTaskInCatalog, type TaskDetail } from "./findTaskInCatalog.js";
import { loadTaskOutcome } from "./loadTask.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

const OPTIONAL_KEYS = ["context", "constraints", "checkout", "repository", "ref"] as const;

type OptionalKey = (typeof OPTIONAL_KEYS)[number];

export type UpdateTaskInput = {
  goal: string;
  optional: Partial<Record<OptionalKey, string | null>>;
};

export type UpdateTaskParseError = {
  ok: false;
  status: 400;
  error: string;
};

export type UpdateTaskResult =
  | { ok: true; task: TaskDetail }
  | { ok: false; status: 400 | 404 | 500; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseUpdateTaskBody(body: unknown): UpdateTaskInput | UpdateTaskParseError {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  if (typeof body.goal !== "string" || body.goal.length === 0) {
    return { ok: false, status: 400, error: "goal is required" };
  }
  const optional: UpdateTaskInput["optional"] = {};
  for (const key of OPTIONAL_KEYS) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (value === null || value === "") {
      optional[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      return { ok: false, status: 400, error: `${key} must be a string` };
    }
    optional[key] = value;
  }
  return { goal: body.goal, optional };
}

export async function updateTask(
  cwd: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<UpdateTaskResult> {
  const found = await findTaskInCatalog(cwd, taskId);
  if (!found) {
    return { ok: false, status: 404, error: `Task not found: ${taskId}` };
  }
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  if (ctx.projectRoot === null) {
    return { ok: false, status: 404, error: `Task not found: ${taskId}` };
  }
  const filePath = path.resolve(ctx.projectRoot, found.path);
  let original: string;
  try {
    original = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
  const doc = parseDocument(original);
  if (!doc.contents || typeof doc.contents !== "object") {
    return { ok: false, status: 500, error: "Task YAML must be an object" };
  }
  doc.set("goal", input.goal);
  for (const key of OPTIONAL_KEYS) {
    if (!Object.hasOwn(input.optional, key)) continue;
    const value = input.optional[key];
    if (value === null || value === "") doc.delete(key);
    else doc.set(key, value);
  }
  const patched = doc.toString();
  const text = patched.endsWith("\n") ? patched : `${patched}\n`;
  try {
    await writeFile(filePath, text, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  }
  const outcome = await loadTaskOutcome(filePath);
  if (!outcome.ok) {
    try {
      await writeFile(filePath, original, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 500, error: message };
    }
    return {
      ok: false,
      status: 400,
      error: outcome.issues[0]?.message ?? "Invalid task",
    };
  }
  const task = await findTaskInCatalog(cwd, taskId);
  if (!task) {
    return { ok: false, status: 500, error: "Task updated but not found" };
  }
  return { ok: true, task };
}
