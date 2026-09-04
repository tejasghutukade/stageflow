import { access } from "node:fs/promises";
import path from "node:path";
import type {
  LoadedPipeline,
  PipelineConfig,
  PipelineStageSource,
} from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import { mergePipelineStages } from "./mergePipelineIncludes.js";
import {
  normalizePipelineStageEntries,
  toWiringRefs,
} from "./normalizePipelineStageEntry.js";
import { loadStageFromObjectOutcome, loadStageOutcome } from "./loadStage.js";
import { resolvePipelineDagFromRefs } from "./resolvePipelineDag.js";
import { validateCompletionContractForStage } from "./validateCompletionContract.js";

export type { LoadedPipeline } from "../types/pipeline.js";
export type { LoadIssue, LoadOutcome } from "./loadOutcome.js";

export async function resolvePipelinePath(
  pipelinePath: string,
  cwd: string,
): Promise<string> {
  const resolved = path.normalize(path.resolve(cwd, pipelinePath));
  try {
    await access(resolved);
    return resolved;
  } catch {
    throw new Error(
      `Pipeline file not found: ${resolved}. Pass a filesystem path to --pipeline (e.g. pipelines/hello.pipeline.yaml), not a bare pipeline id.`,
    );
  }
}

async function loadPipelineFromPath(
  pipelinePath: string,
): Promise<LoadOutcome<LoadedPipeline>> {
  const normalizedPipelinePath = path.normalize(path.resolve(pipelinePath));

  const mergeOutcome = await mergePipelineStages(normalizedPipelinePath);
  if (!mergeOutcome.ok) {
    return loadFailure(mergeOutcome.issues);
  }

  const { entries: rawEntries, pipelineId } = mergeOutcome.value;
  const ctx = { pipelineId, path: normalizedPipelinePath };

  const normalizeOutcome = normalizePipelineStageEntries(rawEntries, ctx);
  if (!normalizeOutcome.ok) {
    return loadFailure(normalizeOutcome.issues);
  }

  const normalizedEntries = normalizeOutcome.value;
  const wiringRefs = toWiringRefs(normalizedEntries);

  let stageIds: string[];
  let dag: LoadedPipeline["dag"];
  try {
    const resolved = resolvePipelineDagFromRefs(wiringRefs, ctx);
    stageIds = resolved.stages;
    dag = resolved.dag;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "pipeline.dag_error",
        message,
        category: "pipeline",
        pipelineId,
      },
    ]);
  }

  const entryById = new Map(normalizedEntries.map((entry) => [entry.id, entry]));
  const stageSources: Record<string, PipelineStageSource> = {};
  const stages: StageConfig[] = [];

  for (const stageId of stageIds) {
    const entry = entryById.get(stageId);
    if (!entry) {
      return loadFailure([
        {
          code: "pipeline.invalid_shape",
          message: `Pipeline ${pipelineId}: missing normalized entry for stage "${stageId}"`,
          category: "pipeline",
          pipelineId,
        },
      ]);
    }

    if (entry.body.kind === "inline") {
      const inlineOutcome = loadStageFromObjectOutcome(entry.body.raw, {
        entryId: entry.id,
        declaringPath: entry.declaringPath,
      });
      if (!inlineOutcome.ok) {
        return loadFailure(inlineOutcome.issues);
      }
      stages.push(inlineOutcome.value);
      stageSources[stageId] = { kind: "inline" };
      continue;
    }

    const stageOutcome = await loadStageOutcome(entry.body.absolutePath);
    if (!stageOutcome.ok) {
      return loadFailure([
        {
          code: "pipeline.missing_stage",
          message: `Pipeline ${pipelineId} references missing stage "${stageId}" at ${entry.body.absolutePath}`,
          category: "pipeline",
          pipelineId,
        },
        ...stageOutcome.issues,
      ]);
    }

    if (stageOutcome.value.id !== entry.id) {
      return loadFailure([
        {
          code: "pipeline.stage_id_mismatch",
          message: `Pipeline ${pipelineId}: stage entry "${entry.id}" in ${entry.declaringPath} uses ${entry.body.path} which declares id "${stageOutcome.value.id}"`,
          category: "pipeline",
          pipelineId,
        },
      ]);
    }

    const stage: StageConfig = {
      ...stageOutcome.value,
      ...(entry.skill !== undefined ? { skill: entry.skill } : {}),
    };
    stages.push(stage);
    stageSources[stageId] = { kind: "file", path: entry.body.absolutePath };
  }

  const pipeline: PipelineConfig = {
    id: pipelineId,
    stages: stageIds,
  };

  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));
  for (const stage of stages) {
    const completion = nodeById.get(stage.id)?.completion;
    const completionOutcome = validateCompletionContractForStage(stage, completion);
    if (!completionOutcome.ok) return loadFailure(completionOutcome.issues);
  }

  return loadSuccess({
    pipeline,
    stages,
    dag,
    pipelinePath: normalizedPipelinePath,
    stageSources,
  });
}

export async function loadPipelineOutcome(
  nameOrPath: string,
  options: { cwd?: string } = {},
): Promise<LoadOutcome<LoadedPipeline>> {
  const cwd = options.cwd ?? process.cwd();

  let pipelinePath: string;
  try {
    pipelinePath = await resolvePipelinePath(nameOrPath, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([
      {
        code: "pipeline.load_error",
        message,
        category: "pipeline",
      },
    ]);
  }

  return loadPipelineFromPath(pipelinePath);
}

export async function loadPipeline(
  nameOrPath: string,
  options: { cwd?: string } = {},
): Promise<LoadedPipeline> {
  const outcome = await loadPipelineOutcome(nameOrPath, options);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
