export function displayCatalogPath(absPath: string, projectRoot?: string): string {
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
    const normalized = absPath.replace(/\\/g, "/");
    if (normalized === root) return ".";
    const prefix = `${root}/`;
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }
  const parts = absPath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? absPath;
}

export function normalizeCatalogSlashes(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export type PipelinePathMatchInput = {
  pipeline_id: string;
  pipeline_path?: string;
  project_root?: string;
};

export type PipelineListingPath = {
  id: string;
  path: string;
};

export function matchPipelineRun(
  run: PipelinePathMatchInput,
  pipeline: PipelineListingPath,
): boolean {
  if (run.pipeline_id === pipeline.id) return true;
  if (run.pipeline_path && run.project_root) {
    const rel = displayCatalogPath(run.pipeline_path, run.project_root);
    if (normalizeCatalogSlashes(rel) === normalizeCatalogSlashes(pipeline.path)) {
      return true;
    }
  }
  return false;
}

export function runLocatorSubtitle(run: {
  pipeline_id: string;
  task_id?: string;
  pipeline_path?: string;
  task_path?: string;
  project_root?: string;
}): string {
  const pipelineLabel = run.pipeline_path
    ? displayCatalogPath(run.pipeline_path, run.project_root)
    : run.pipeline_id;
  const taskLabel = run.task_path
    ? displayCatalogPath(run.task_path, run.project_root)
    : run.task_id;
  if (taskLabel) {
    return `${pipelineLabel} · ${taskLabel}`;
  }
  return pipelineLabel;
}

export function runTaskLabel(run: {
  task_id?: string;
  task_path?: string;
  project_root?: string;
  pipeline_id: string;
}): string {
  if (run.task_path) {
    return displayCatalogPath(run.task_path, run.project_root);
  }
  return run.task_id ?? run.pipeline_id;
}
