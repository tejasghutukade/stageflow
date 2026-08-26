import type { StageGateKind } from "../types/stage.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import {
  listModelsForContext,
  listPipelinesForContext,
  listTasksForContext,
  type PipelineListing,
  type PipelineStageListing,
  type TaskListing,
} from "./browseCatalog.js";
import { resolveStageflowContext, type StageflowContext } from "../project/resolveStageflowContext.js";
import { catalogContextFromStageflow, type CatalogContext } from "./resolveCatalogContext.js";

export type { PipelineListing, PipelineStageListing, TaskListing } from "./browseCatalog.js";

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

export async function listTasks(options: CatalogListOptions): Promise<TaskListing[]> {
  return listTasksForContext({
    projectRoot: options.projectRoot,
    manifest: options.manifest,
    manifestStatus: "ok",
    issues: [],
  });
}

export async function listPipelines(options: CatalogListOptions): Promise<PipelineListing[]> {
  return listPipelinesForContext({
    projectRoot: options.projectRoot,
    manifest: options.manifest,
    manifestStatus: "ok",
    issues: [],
  });
}

export async function listStages(_options?: unknown): Promise<StageListing[]> {
  return [];
}

export async function listModels(
  cwdOrContext: string | CatalogContext | StageflowContext,
): Promise<string[]> {
  const ctx =
    typeof cwdOrContext === "string"
      ? catalogContextFromStageflow(await resolveStageflowContext(cwdOrContext))
      : "manifestIssues" in cwdOrContext
        ? catalogContextFromStageflow(cwdOrContext)
        : cwdOrContext;
  return listModelsForContext(ctx);
}
