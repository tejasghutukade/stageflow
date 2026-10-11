import path from "node:path";
import type { TaskFile } from "../types/task.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { loadTaskOutcome } from "./loadTask.js";
import { listTasksMultiProject } from "./multiProjectCatalog.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import {
  findCatalogRoot,
  type ResolveCatalogRootsOptions,
} from "./resolveCatalogRoots.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

export type TaskDetail = TaskFile & { path: string };

export type TaskDetailWithRoot = TaskDetail & { project_root: string };

export type FindTaskInCatalogMultiResult =
  | { ok: true; task: TaskDetailWithRoot }
  | { ok: false; status: 404; error: string }
  | {
      ok: false;
      status: 400;
      error: string;
      code: "unknown_project_root";
    }
  | {
      ok: false;
      status: 409;
      error: string;
      code: "ambiguous_task";
      project_roots: string[];
    };

export async function findTaskInProjectRoot(
  projectRoot: string,
  taskId: string,
): Promise<TaskDetail | null> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(projectRoot));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths || ctx.projectRoot === null) {
    return null;
  }
  const root = ctx.projectRoot;
  for (const filePath of scanPaths.taskPaths) {
    const outcome = await loadTaskOutcome(filePath);
    if (!outcome.ok || outcome.value.id !== taskId) {
      continue;
    }
    return {
      ...outcome.value,
      path: path.relative(root, filePath).replace(/\\/g, "/"),
    };
  }
  return null;
}

export async function findTaskInCatalogMulti(
  options: ResolveCatalogRootsOptions & {
    taskId: string;
    projectRootFilter?: string;
  },
): Promise<FindTaskInCatalogMultiResult> {
  const { taskId, projectRootFilter, ...rootOptions } = options;
  const listed = await listTasksMultiProject({
    ...rootOptions,
    projectRootFilter,
  });
  if (
    projectRootFilter !== undefined &&
    listed.root_errors.some((e) => e.code === "unknown_project_root")
  ) {
    return {
      ok: false,
      status: 400,
      error: listed.root_errors[0]!.message,
      code: "unknown_project_root",
    };
  }
  const matches = listed.items.filter((t) => t.id === taskId);
  if (matches.length === 0) {
    return { ok: false, status: 404, error: `Task not found: ${taskId}` };
  }
  const projectRoots = [...new Set(matches.map((m) => m.project_root))];
  if (projectRoots.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Task id is ambiguous across catalog roots: ${taskId}`,
      code: "ambiguous_task",
      project_roots: projectRoots.sort((a, b) => a.localeCompare(b)),
    };
  }
  const wireRoot = projectRoots[0]!;
  const catalogRoot = findCatalogRoot(listed.roots, wireRoot);
  if (catalogRoot === undefined) {
    return { ok: false, status: 404, error: `Task not found: ${taskId}` };
  }
  const detail = await findTaskInProjectRoot(catalogRoot.path, taskId);
  if (!detail) {
    return { ok: false, status: 404, error: `Task not found: ${taskId}` };
  }
  return { ok: true, task: { ...detail, project_root: wireRoot } };
}

export async function findTaskInCatalog(
  cwd: string,
  taskId: string,
): Promise<TaskDetail | null> {
  return findTaskInProjectRoot(cwd, taskId);
}
