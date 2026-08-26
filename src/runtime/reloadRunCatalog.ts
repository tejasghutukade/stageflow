import { access } from "node:fs/promises";
import { loadPipeline } from "../config/loadPipeline.js";
import { loadTask } from "../config/loadTask.js";
import { normalizeCatalogPath } from "../runstore/normalizeCatalogPath.js";
import type { RunMeta } from "../runstore/port.js";
import type { LoadedPipeline } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";

function missingLocator(field: string, runId: string): never {
  throw new Error(
    `Run ${runId} is missing ${field}; reload requires stored catalog locators.`,
  );
}

function requireProjectRoot(meta: RunMeta): string {
  if (!meta.project_root) {
    missingLocator("project_root", meta.run_id);
  }
  return normalizeCatalogPath(meta.project_root);
}

function requirePipelinePath(meta: RunMeta): string {
  if (!meta.pipeline_path) {
    missingLocator("pipeline_path", meta.run_id);
  }
  return normalizeCatalogPath(meta.pipeline_path);
}

function requireTaskPath(meta: RunMeta): string {
  if (!meta.task_path) {
    missingLocator("task_path", meta.run_id);
  }
  return normalizeCatalogPath(meta.task_path);
}

async function assertCatalogFileExists(
  filePath: string,
  label: string,
): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} not found at stored path: ${filePath}`);
  }
}

export async function reloadPipelineForRun(
  meta: RunMeta,
): Promise<LoadedPipeline> {
  const projectRoot = requireProjectRoot(meta);
  const pipelinePath = requirePipelinePath(meta);
  await assertCatalogFileExists(pipelinePath, "Pipeline");
  return loadPipeline(pipelinePath, { cwd: projectRoot });
}

export async function reloadTaskForRun(meta: RunMeta): Promise<TaskFile> {
  const taskPath = requireTaskPath(meta);
  await assertCatalogFileExists(taskPath, "Task");
  return loadTask(taskPath);
}
