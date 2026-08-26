import path from "node:path";
import type { StageGateKind } from "../types/stage.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { PipelineStageSource } from "../types/pipeline.js";
import { resolveCatalogContext, type CatalogContext } from "./resolveCatalogContext.js";
import { listModelsFromManifest } from "./listModelsFromManifest.js";
import { loadPipeline } from "./loadPipeline.js";
import { loadTask } from "./loadTask.js";
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

export type ValidStageListing = {
  path: string;
  id: string;
  used_by_pipeline_ids: string[];
  gate_kinds?: StageGateKind[];
};

export type BrokenStageListing = {
  path: string;
  error: string;
  id?: string;
  model?: string;
  gate_kinds?: StageGateKind[];
};

export type StageListing = ValidStageListing | BrokenStageListing;

export type CatalogListOptions = {
  projectRoot: string;
  manifest: LoadedManifest;
};

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

export async function listTasks(options: CatalogListOptions): Promise<TaskListing[]> {
  const { projectRoot, manifest } = options;
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
    } catch {
      // skip invalid
    }
  }

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

export async function listPipelines(options: CatalogListOptions): Promise<PipelineListing[]> {
  const { projectRoot, manifest } = options;
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
    } catch {
      // skip invalid
    }
  }

  listings.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.id.localeCompare(b.id);
  });
  return listings;
}

export async function listStages(_options?: unknown): Promise<StageListing[]> {
  return [];
}

export async function listModels(cwdOrContext: string | CatalogContext): Promise<string[]> {
  const ctx =
    typeof cwdOrContext === "string"
      ? await resolveCatalogContext(cwdOrContext)
      : cwdOrContext;
  return listModelsFromManifest(ctx);
}
