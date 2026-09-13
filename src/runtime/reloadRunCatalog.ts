import { access } from "node:fs/promises";
import { loadPipeline } from "../config/loadPipeline.js";
import { loadTask } from "../config/loadTask.js";
import { sleepAbortable } from "../mcp/waitRun.js";
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

// A container-executed stage attempt mounts the same host path the run
// store just wrote a moment ago; on Docker Desktop's virtiofs bind mounts
// that write can take a short beat to become visible from inside a
// freshly-started container (observed consistently in manual testing,
// resolved by the time a follow-up command ran a few seconds later). A
// few short retries absorb that settle time. This check runs on every
// stage-worker startup regardless of execution mode, so a genuinely
// missing file under host-process (fork) execution — which never has
// this race — now takes up to ~400ms to report instead of failing
// instantly; that's an accepted trade-off for v1, not a zero-cost fix.
const CATALOG_FILE_EXISTS_RETRIES = 5;
const CATALOG_FILE_EXISTS_RETRY_DELAY_MS = 100;

async function assertCatalogFileExists(
  filePath: string,
  label: string,
): Promise<void> {
  for (let attempt = 1; attempt <= CATALOG_FILE_EXISTS_RETRIES; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      if (attempt === CATALOG_FILE_EXISTS_RETRIES) {
        throw new Error(`${label} not found at stored path: ${filePath}`);
      }
      await sleepAbortable(CATALOG_FILE_EXISTS_RETRY_DELAY_MS);
    }
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
