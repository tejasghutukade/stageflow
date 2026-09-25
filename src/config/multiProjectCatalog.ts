import {
  listModelsForContext,
  listPipelinesForContext,
  listTasksForContext,
  type PipelineListing,
  type TaskListing,
} from "./browseCatalog.js";
import {
  loadStageflowManifestOutcome,
} from "./loadStageflowManifest.js";
import type { CatalogContext } from "./resolveCatalogContext.js";
import {
  findCatalogRoot,
  isRootReadable,
  resolveCatalogRoots,
  type CatalogRoot,
  type ResolveCatalogRootsOptions,
} from "./resolveCatalogRoots.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

export type CatalogRootError = {
  project_root: string;
  code: "catalog_root_unreadable" | "unknown_project_root";
  message: string;
};

export type MultiProjectListResult<T> = {
  items: T[];
  root_errors: CatalogRootError[];
  roots: CatalogRoot[];
};

async function catalogContextForRoot(root: CatalogRoot): Promise<CatalogContext> {
  if (root.kind === "seeded") {
    const outcome = await loadStageflowManifestOutcome(root.path);
    if (!outcome.ok) {
      return {
        projectRoot: root.path,
        manifest: null,
        manifestStatus: "invalid",
        issues: outcome.issues,
      };
    }
    return {
      projectRoot: root.path,
      manifest: outcome.value,
      manifestStatus: "ok",
      issues: [],
    };
  }
  return catalogContextFromStageflow(await resolveStageflowContext(root.path));
}

async function selectRoots(
  options: ResolveCatalogRootsOptions & { projectRootFilter?: string },
): Promise<{
  roots: CatalogRoot[];
  selected: CatalogRoot[];
  root_errors: CatalogRootError[];
}> {
  const roots = await resolveCatalogRoots(options);
  const root_errors: CatalogRootError[] = [];

  if (options.projectRootFilter !== undefined) {
    const match = findCatalogRoot(roots, options.projectRootFilter);
    if (match === undefined) {
      return {
        roots,
        selected: [],
        root_errors: [
          {
            project_root: options.projectRootFilter,
            code: "unknown_project_root",
            message: `Unknown project_root: ${options.projectRootFilter}`,
          },
        ],
      };
    }
    if (!(await isRootReadable(match.path))) {
      return {
        roots,
        selected: [],
        root_errors: [
          {
            project_root: match.project_root,
            code: "catalog_root_unreadable",
            message: `Catalog root is unreadable: ${match.project_root}`,
          },
        ],
      };
    }
    return { roots, selected: [match], root_errors };
  }

  const selected: CatalogRoot[] = [];
  for (const root of roots) {
    if (!(await isRootReadable(root.path))) {
      root_errors.push({
        project_root: root.project_root,
        code: "catalog_root_unreadable",
        message: `Catalog root is unreadable: ${root.project_root}`,
      });
      continue;
    }
    selected.push(root);
  }
  return { roots, selected, root_errors };
}

export async function listPipelinesMultiProject(
  options: ResolveCatalogRootsOptions & { projectRootFilter?: string },
): Promise<MultiProjectListResult<PipelineListing & { project_root: string }>> {
  const { roots, selected, root_errors } = await selectRoots(options);
  const items: Array<PipelineListing & { project_root: string }> = [];
  for (const root of selected) {
    try {
      const ctx = await catalogContextForRoot(root);
      const pipelines = await listPipelinesForContext(ctx);
      for (const p of pipelines) {
        items.push({ ...p, project_root: root.project_root });
      }
    } catch (err) {
      root_errors.push({
        project_root: root.project_root,
        code: "catalog_root_unreadable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { items, root_errors, roots };
}

export async function listTasksMultiProject(
  options: ResolveCatalogRootsOptions & { projectRootFilter?: string },
): Promise<MultiProjectListResult<TaskListing & { project_root: string }>> {
  const { roots, selected, root_errors } = await selectRoots(options);
  const items: Array<TaskListing & { project_root: string }> = [];
  for (const root of selected) {
    try {
      const ctx = await catalogContextForRoot(root);
      const tasks = await listTasksForContext(ctx);
      for (const t of tasks) {
        items.push({ ...t, project_root: root.project_root });
      }
    } catch (err) {
      root_errors.push({
        project_root: root.project_root,
        code: "catalog_root_unreadable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { items, root_errors, roots };
}

export async function listModelsMultiProject(
  options: ResolveCatalogRootsOptions & { projectRootFilter?: string },
): Promise<
  MultiProjectListResult<{ id: string; project_root: string }> & {
    models: string[];
  }
> {
  const { roots, selected, root_errors } = await selectRoots(options);
  const items: Array<{ id: string; project_root: string }> = [];
  const modelSet = new Set<string>();
  for (const root of selected) {
    try {
      const ctx = await catalogContextForRoot(root);
      const models = await listModelsForContext(ctx);
      for (const id of models) {
        modelSet.add(id);
        items.push({ id, project_root: root.project_root });
      }
    } catch (err) {
      root_errors.push({
        project_root: root.project_root,
        code: "catalog_root_unreadable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    items,
    models: [...modelSet].sort((a, b) => a.localeCompare(b)),
    root_errors,
    roots,
  };
}
