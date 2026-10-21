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
  if (taskLabel && taskLabel !== pipelineLabel) {
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

export type BindingLocatorInput = {
  kind: "repository" | "checkout" | "unbound";
  repository?: string;
  ref?: string;
  resolved_sha?: string;
  run_branch?: string;
  checkout_root?: string;
};

function truncateSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export function bindingLocatorText(binding: BindingLocatorInput): string {
  if (binding.kind === "unbound") return "unbound";
  if (binding.kind === "checkout") {
    if (!binding.checkout_root) return "checkout · unavailable";
    return `checkout · ${pathBasename(binding.checkout_root)}`;
  }
  const parts = ["repository"];
  if (binding.repository) parts.push(binding.repository);
  if (binding.ref) parts.push(binding.ref);
  if (binding.resolved_sha) parts.push(truncateSha(binding.resolved_sha));
  if (binding.run_branch) parts.push(binding.run_branch);
  if (parts.length === 1 && !binding.repository) {
    return "repository · unavailable";
  }
  return parts.join(" · ");
}

export function bindingLocatorTitle(binding: BindingLocatorInput): string {
  if (binding.kind === "unbound") return "unbound";
  if (binding.kind === "checkout") {
    return binding.checkout_root ?? "checkout unavailable";
  }
  const lines: string[] = [];
  if (binding.resolved_sha) lines.push(binding.resolved_sha);
  if (binding.checkout_root) lines.push(binding.checkout_root);
  return lines.length > 0 ? lines.join("\n") : bindingLocatorText(binding);
}

export function bindingListCompactText(binding: {
  kind: "repository" | "checkout" | "unbound";
  repository?: string;
  ref?: string;
  resolved_sha?: string;
}): string {
  if (binding.kind === "unbound") return "unbound";
  if (binding.kind === "checkout") return "checkout";
  const parts = ["repository"];
  if (binding.repository) parts.push(binding.repository);
  if (binding.ref) parts.push(binding.ref);
  if (binding.resolved_sha) parts.push(truncateSha(binding.resolved_sha));
  return parts.join(" · ");
}

