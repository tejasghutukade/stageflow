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
