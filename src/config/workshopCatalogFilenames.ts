const PIPELINE_SUFFIX = ".pipeline.yaml";
const TASK_SUFFIX = ".task.yaml";

function basenameOnly(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1]?.trim() || trimmed;
}

export function normalizePipelineCatalogFilename(
  pipelineId: string,
  filename?: string | null,
): string {
  const id = pipelineId.trim() || "untitled";
  const base = filename?.trim() ? basenameOnly(filename) : "";
  if (base.endsWith(PIPELINE_SUFFIX)) {
    const stem = base.slice(0, -PIPELINE_SUFFIX.length);
    if (stem === id) return base;
  }
  return `${id}${PIPELINE_SUFFIX}`;
}

export function taskIdFromDraftTask(task: {
  filename?: string;
  body?: Record<string, unknown>;
}): string {
  const bodyId = task.body?.id;
  if (typeof bodyId === "string" && bodyId.trim()) return bodyId.trim();
  const base = task.filename?.trim() ? basenameOnly(task.filename) : "";
  if (!base) return "task";
  return (
    base
      .replace(/\.task\.ya?ml$/i, "")
      .replace(/\.ya?ml$/i, "")
      .trim() || "task"
  );
}

export function normalizeTaskCatalogFilename(
  taskId: string,
  filename?: string | null,
): string {
  const id = taskId.trim() || "task";
  const base = filename?.trim() ? basenameOnly(filename) : "";
  if (base.endsWith(TASK_SUFFIX)) {
    const stem = base.slice(0, -TASK_SUFFIX.length);
    if (stem === id) return base;
  }
  return `${id}${TASK_SUFFIX}`;
}

export type DraftTaskArtifact = {
  filename: string;
  body: Record<string, unknown>;
};

export type DraftPackageFilenames = {
  pipeline: { id: string };
  task?: DraftTaskArtifact;
};

const CATALOG_KIND_SUFFIX_PATTERN = /\.(pipeline|task|trigger)\.ya?ml$/i;
const BARE_YAML_PATTERN = /\.ya?ml$/i;

export type CatalogYamlKind = "pipeline" | "task" | "other";

export function classifyCatalogYamlDocument(
  raw: Record<string, unknown>,
): CatalogYamlKind {
  if (Array.isArray(raw.stages)) return "pipeline";
  if (typeof raw.goal === "string" || typeof raw.pipeline === "string") {
    return "task";
  }
  return "other";
}

export function legacyBareCatalogFilenames(entityId: string): string[] {
  const id = entityId.trim();
  if (!id) return [];
  return [`${id}.yaml`, `${id}.yml`];
}

export function isMisnamedCatalogBasename(basename: string): boolean {
  const name = basename.trim();
  if (!BARE_YAML_PATTERN.test(name)) return false;
  if (!CATALOG_KIND_SUFFIX_PATTERN.test(name)) return true;
  return /\.(pipeline|task)\.yml$/i.test(name);
}

export function canonicalCatalogBasenameForDocument(
  raw: Record<string, unknown>,
  sourceBasename?: string,
): string | null {
  const kind = classifyCatalogYamlDocument(raw);
  const id = raw.id;
  if (typeof id !== "string" || !id.trim()) return null;
  if (kind === "pipeline") return normalizePipelineCatalogFilename(id);
  if (kind === "task") return normalizeTaskCatalogFilename(id);
  if (sourceBasename && CATALOG_KIND_SUFFIX_PATTERN.test(sourceBasename)) {
    const stem = sourceBasename.replace(/\.ya?ml$/i, "");
    const kindSuffix = stem.match(/\.(pipeline|task|trigger)$/i)?.[1]?.toLowerCase();
    if (kindSuffix === "pipeline") {
      return normalizePipelineCatalogFilename(id);
    }
    if (kindSuffix === "task") {
      return normalizeTaskCatalogFilename(id);
    }
  }
  return null;
}

export type WorkshopCatalogRepairMove = {
  from: string;
  to: string;
};

export type WorkshopCatalogRepairResult = {
  renamed: WorkshopCatalogRepairMove[];
  removed: string[];
};

export function reconcileWorkshopCatalogFilenames(
  pipelineId: string,
  taskId?: string | null,
  canonicalPipelineBasename?: string,
  canonicalTaskBasename?: string | null,
): { renameCandidates: WorkshopCatalogRepairMove[]; removeCandidates: string[] } {
  const renameCandidates: WorkshopCatalogRepairMove[] = [];
  const removeCandidates: string[] = [];
  const pipelineCanonical =
    canonicalPipelineBasename?.trim() ||
    normalizePipelineCatalogFilename(pipelineId);
  const taskCanonical = taskId?.trim()
    ? canonicalTaskBasename?.trim() ||
      normalizeTaskCatalogFilename(taskId)
    : null;

  for (const legacy of legacyBareCatalogFilenames(pipelineId)) {
    if (legacy === pipelineCanonical) continue;
    removeCandidates.push(legacy);
  }
  if (taskId?.trim()) {
    for (const legacy of legacyBareCatalogFilenames(taskId)) {
      if (legacy === taskCanonical || legacy === pipelineCanonical) continue;
      removeCandidates.push(legacy);
    }
  }

  return { renameCandidates, removeCandidates };
}

export function normalizeDraftCatalogFilenames<T extends DraftPackageFilenames>(
  draft: T,
  pipelineFilename?: string | null,
): { draft: T; pipelineFilename: string } {
  const pipelineFilenameOut = normalizePipelineCatalogFilename(
    draft.pipeline.id,
    pipelineFilename,
  );
  if (!draft.task) {
    return { draft, pipelineFilename: pipelineFilenameOut };
  }
  const taskId = taskIdFromDraftTask(draft.task);
  const taskFilename = normalizeTaskCatalogFilename(taskId, draft.task.filename);
  if (taskFilename === draft.task.filename) {
    return { draft, pipelineFilename: pipelineFilenameOut };
  }
  return {
    draft: {
      ...draft,
      task: { ...draft.task, filename: taskFilename },
    },
    pipelineFilename: pipelineFilenameOut,
  };
}
