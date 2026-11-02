import { access } from "node:fs/promises";
import type { LoadedStageConfig, StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
} from "./loadStageflowManifest.js";
import type { IndependenceLevel } from "../types/stage.js";
import { globalModelFromManifest, resolveModelOutcome } from "./resolveModel.js";
import { globalIndependenceFromManifest, resolveIndependence } from "./resolveIndependence.js";

export async function materializeStageModels(
  stages: StageConfig[],
  options: {
    pipelineModel?: string;
    pipelineIndependence?: IndependenceLevel;
    pipelineId: string;
    projectRoot: string;
  },
): Promise<LoadOutcome<LoadedStageConfig[]>> {
  let globalModel: string | undefined;
  let globalIndependence: IndependenceLevel | undefined;
  const manifestPath = manifestPathForProject(options.projectRoot);
  let manifestExists = true;
  try {
    await access(manifestPath);
  } catch {
    manifestExists = false;
  }
  if (manifestExists) {
    const manifestOutcome = await loadStageflowManifestOutcome(options.projectRoot);
    if (!manifestOutcome.ok) {
      return loadFailure(manifestOutcome.issues);
    }
    globalModel = globalModelFromManifest(manifestOutcome.value);
    globalIndependence = globalIndependenceFromManifest(manifestOutcome.value);
  }

  const materialized: LoadedStageConfig[] = [];
  for (const stage of stages) {
    const modelOutcome = resolveModelOutcome(
      {
        stage: stage.model,
        pipeline: options.pipelineModel,
        global: globalModel,
      },
      { stageId: stage.id, pipelineId: options.pipelineId },
    );
    if (!modelOutcome.ok) {
      return loadFailure(modelOutcome.issues);
    }
    materialized.push({
      ...stage,
      model: modelOutcome.value.model,
      model_tier: modelOutcome.value.tier,
      independence: resolveIndependence({
        stage: stage.independence,
        pipeline: options.pipelineIndependence,
        global: globalIndependence,
      }),
    });
  }
  return loadSuccess(materialized);
}
