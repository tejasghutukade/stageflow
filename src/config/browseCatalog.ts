import path from "node:path";
import type { StageGateKind } from "../types/stage.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { PipelineStageSource } from "../types/pipeline.js";
import type { LoadIssue } from "./loadOutcome.js";
import { loadPipeline } from "./loadPipeline.js";
import { loadTask } from "./loadTask.js";
import type { CatalogContext } from "./resolveCatalogContext.js";
import {
  resolveStageflowContext,
  type CatalogManifestStatus,
  type StageflowContext,
} from "../project/resolveStageflowContext.js";
import { scanCatalogPaths } from "./scanCatalogPaths.js";

export type TaskListing = {
  path: string;
  id: string;
  goal: string;
};

export type PipelineStageListing = {
  id: string;
  gate_kinds?: StageGateKind[];
  uses_path?: string;
  inline?: boolean;
};

export type PipelineListing = {
  path: string;
  id: string;
  stages: PipelineStageListing[];
};

export type CatalogBrowseWarning = {
  path: string;
  kind: "pipeline" | "task";
  error: string;
};

export type CatalogBrowseResult = {
  projectRoot: string | null;
  manifest: LoadedManifest | null;
  manifestStatus: CatalogManifestStatus;
  issues: LoadIssue[];
  pipelines: PipelineListing[];
  tasks: TaskListing[];
  models: string[];
  warnings: CatalogBrowseWarning[];
};

export type CatalogScanPaths = {
  pipelinePaths: string[];
  taskPaths: string[];
};

const BAKED_MODEL_IDS = [
  "anthropic/claude-sonnet-4-5",
  "cursor/auto",
  "cursor/composer-2-5",
] as const;

function repoRelPath(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).replace(/\\/g, "/");
}

function mapStageListing(
  stage: { id: string; gate_kinds?: StageGateKind[] },
  source: PipelineStageSource | undefined,
  projectRoot: string,
): PipelineStageListing {
  const listing: PipelineStageListing = {
    id: stage.id,
    ...(stage.gate_kinds ? { gate_kinds: stage.gate_kinds } : {}),
  };
  if (source?.kind === "inline") {
    listing.inline = true;
  } else if (source?.kind === "file") {
    listing.uses_path = repoRelPath(projectRoot, source.path);
  }
  return listing;
}

function bakedModels(): string[] {
  return [...BAKED_MODEL_IDS].sort((a, b) => a.localeCompare(b));
}

function catalogReadyFromStageflow(
  ctx: StageflowContext,
): ctx is StageflowContext & { manifest: LoadedManifest } {
  return ctx.isGitProject && ctx.manifestStatus === "ok" && ctx.manifest !== null;
}

function catalogReady(ctx: CatalogContext): ctx is CatalogContext & {
  projectRoot: string;
  manifest: LoadedManifest;
} {
  return ctx.manifestStatus === "ok" && ctx.projectRoot !== null && ctx.manifest !== null;
}

export async function getCatalogScanPaths(
  ctx: CatalogContext,
): Promise<CatalogScanPaths | null> {
  if (!catalogReady(ctx)) {
    return null;
  }
  const [pipelinePaths, taskPaths] = await Promise.all([
    scanCatalogPaths(ctx.manifest, "pipeline"),
    scanCatalogPaths(ctx.manifest, "task"),
  ]);
  return { pipelinePaths, taskPaths };
}

async function listTasksFromManifest(
  projectRoot: string,
  manifest: LoadedManifest,
  warnings: CatalogBrowseWarning[],
): Promise<TaskListing[]> {
  const filePaths = await scanCatalogPaths(manifest, "task");
  const listings: TaskListing[] = [];

  for (const filePath of filePaths) {
    try {
      const task = await loadTask(filePath);
      listings.push({
        path: repoRelPath(projectRoot, filePath),
        id: task.id,
        goal: task.goal,
      });
    } catch (err) {
      warnings.push({
        path: repoRelPath(projectRoot, filePath),
        kind: "task",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

async function listPipelinesFromManifest(
  projectRoot: string,
  manifest: LoadedManifest,
  warnings: CatalogBrowseWarning[],
): Promise<PipelineListing[]> {
  const filePaths = await scanCatalogPaths(manifest, "pipeline");
  const listings: PipelineListing[] = [];

  for (const filePath of filePaths) {
    try {
      const loaded = await loadPipeline(filePath, { cwd: projectRoot });
      listings.push({
        path: repoRelPath(projectRoot, filePath),
        id: loaded.pipeline.id,
        stages: loaded.stages.map((stage) =>
          mapStageListing(stage, loaded.stageSources?.[stage.id], projectRoot),
        ),
      });
    } catch (err) {
      warnings.push({
        path: repoRelPath(projectRoot, filePath),
        kind: "pipeline",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

async function listModelsFromManifest(
  projectRoot: string,
  manifest: LoadedManifest,
): Promise<string[]> {
  const models = new Set<string>(BAKED_MODEL_IDS);
  const filePaths = await scanCatalogPaths(manifest, "pipeline");
  for (const filePath of filePaths) {
    try {
      const loaded = await loadPipeline(filePath, { cwd: projectRoot });
      for (const stage of loaded.stages) {
        if (stage.model.trim()) {
          models.add(stage.model);
        }
      }
    } catch {
      // skip invalid pipelines
    }
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

export async function browseCatalog(
  invocationCwd: string | StageflowContext,
): Promise<CatalogBrowseResult> {
  const ctx =
    typeof invocationCwd === "string"
      ? await resolveStageflowContext(invocationCwd)
      : invocationCwd;
  const base = {
    projectRoot: ctx.isGitProject ? ctx.projectRoot : null,
    manifest: ctx.manifest,
    manifestStatus: ctx.manifestStatus,
    issues: ctx.manifestIssues,
  };

  if (!catalogReadyFromStageflow(ctx)) {
    return {
      ...base,
      pipelines: [],
      tasks: [],
      models: bakedModels(),
      warnings: [],
    };
  }

  const warnings: CatalogBrowseWarning[] = [];
  const [pipelines, tasks, models] = await Promise.all([
    listPipelinesFromManifest(ctx.projectRoot, ctx.manifest, warnings),
    listTasksFromManifest(ctx.projectRoot, ctx.manifest, warnings),
    listModelsFromManifest(ctx.projectRoot, ctx.manifest),
  ]);

  return {
    ...base,
    pipelines,
    tasks,
    models,
    warnings,
  };
}

export async function listPipelinesForContext(
  ctx: CatalogContext,
): Promise<PipelineListing[]> {
  if (!catalogReady(ctx)) {
    return [];
  }
  return listPipelinesFromManifest(ctx.projectRoot, ctx.manifest, []);
}

export async function listTasksForContext(ctx: CatalogContext): Promise<TaskListing[]> {
  if (!catalogReady(ctx)) {
    return [];
  }
  return listTasksFromManifest(ctx.projectRoot, ctx.manifest, []);
}

export async function listModelsForContext(ctx: CatalogContext): Promise<string[]> {
  if (!catalogReady(ctx)) {
    return bakedModels();
  }
  return listModelsFromManifest(ctx.projectRoot, ctx.manifest);
}
