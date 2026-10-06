import path from "node:path";
import type { TaskFile } from "../types/task.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { loadTaskOutcome } from "./loadTask.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

export type TaskDetail = TaskFile & { path: string };

export async function findTaskInCatalog(
  cwd: string,
  taskId: string,
): Promise<TaskDetail | null> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths || ctx.projectRoot === null) {
    return null;
  }
  const projectRoot = ctx.projectRoot;
  for (const filePath of scanPaths.taskPaths) {
    const outcome = await loadTaskOutcome(filePath);
    if (!outcome.ok || outcome.value.id !== taskId) {
      continue;
    }
    return {
      ...outcome.value,
      path: path.relative(projectRoot, filePath).replace(/\\/g, "/"),
    };
  }
  return null;
}
