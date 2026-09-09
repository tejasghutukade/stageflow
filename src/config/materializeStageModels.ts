import { access } from "node:fs/promises";
import type { LoadedStageConfig, StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
} from "./loadStageflowManifest.js";
import { globalModelFromManifest, resolveModelOutcome } from "./resolveModel.js";

export async function materializeStageModels(
  stages: StageConfig[],
  options: {
    pipelineModel?: string;
    pipelineId: string;
    projectRoot: string;
  },
): Promise<LoadOutcome<LoadedStageConfig[]>> {
  let globalModel: string | undefined;
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
    materialized.push({ ...stage, model: modelOutcome.value });
  }
  return loadSuccess(materialized);
}
