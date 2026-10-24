import path from "node:path";
import { canonicalJson, sha256Hex } from "../evals/canonical.js";
import type { EvalFile } from "../evals/types.js";
import type { CompletionContract } from "../types/completion.js";
import type { LoadedStageConfig } from "../types/stage.js";
import { resolveEvalPaths } from "./loadEval.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { loadPipelineOutcome } from "./loadPipeline.js";
import { afterCompletionForStage, loadStageOutcome } from "./loadStage.js";
import { materializeStageModels } from "./materializeStageModels.js";

export type ResolvedEvalTarget = {
  stageConfig: LoadedStageConfig;
  pipelinePath?: string;
  stageId?: string;
  file?: string;
  stageVersionHash: string;
  completion?: CompletionContract;
  inputSchema?: unknown;
  outputSchema?: unknown;
  modelResolved: string;
  modelTier: "stage" | "pipeline" | "global";
};

function unresolved(message: string): LoadIssue {
  return { code: "eval.target_unresolved", message, category: "eval" };
}

function describeIssues(issues: LoadIssue[]): string {
  return issues.map((issue) => issue.message).join("; ");
}

/** The exact object the stage version hash is computed from. */
export function stageDefinition(
  stage: LoadedStageConfig,
  completion: CompletionContract | undefined,
): Record<string, unknown> {
  const { model_tier: _tier, ...config } = stage;
  return { ...config, ...(completion !== undefined ? { completion } : {}) };
}

/** sha256 of the canonical JSON of the materialized stage config plus its after-phase verify contract. */
export function stageVersionHash(
  stage: LoadedStageConfig,
  completion: CompletionContract | undefined,
): string {
  return sha256Hex(canonicalJson(stageDefinition(stage, completion)));
}

export async function resolveEvalTarget(
  file: EvalFile,
  evalAbsPath: string,
  projectRoot: string,
): Promise<LoadOutcome<ResolvedEvalTarget>> {
  if (file.target.kind !== "stage") {
    return loadFailure([unresolved("Agent targets are resolved by resolveAgentTarget")]);
  }
  const paths = resolveEvalPaths(file, evalAbsPath);
  const rel = (abs: string): string => path.relative(projectRoot, abs).split(path.sep).join("/");

  if (paths.pipelinePath !== undefined) {
    const pipelineRel = rel(paths.pipelinePath);
    const outcome = await loadPipelineOutcome(paths.pipelinePath, { cwd: projectRoot, projectRoot, requireIo: false });
    if (!outcome.ok) {
      return loadFailure([
        unresolved(`Target pipeline ${pipelineRel} does not load: ${describeIssues(outcome.issues)}`),
      ]);
    }
    const { value } = outcome;
    const stageId = file.target.stage as string;
    const stage = value.stages.find((s) => s.id === stageId);
    if (!stage) {
      const known = value.stages.map((s) => s.id).join(", ");
      return loadFailure([
        unresolved(`Target stage "${stageId}" not found in pipeline ${pipelineRel} (stages: ${known})`),
      ]);
    }
    const completion = value.dag.nodes.find((node) => node.id === stageId)?.completion;
    return loadSuccess({
      stageConfig: stage,
      pipelinePath: paths.pipelinePath,
      stageId,
      stageVersionHash: stageVersionHash(stage, completion),
      ...(completion !== undefined ? { completion } : {}),
      inputSchema: stage.clone_input_schema,
      outputSchema: stage.payload_schema,
      modelResolved: stage.model,
      modelTier: stage.model_tier ?? "global",
    });
  }

  const stageFile = paths.stageFile as string;
  const fileRel = rel(stageFile);
  const loaded = await loadStageOutcome(stageFile, { requireIo: false });
  if (!loaded.ok) {
    return loadFailure([
      unresolved(`Target stage file ${fileRel} does not load: ${describeIssues(loaded.issues)}`),
    ]);
  }
  const materialized = await materializeStageModels([loaded.value], {
    pipelineId: `standalone-${loaded.value.id}`,
    projectRoot,
  });
  if (!materialized.ok) {
    return loadFailure([
      unresolved(`Target stage file ${fileRel} has no resolvable model: ${describeIssues(materialized.issues)}`),
    ]);
  }
  const stage = materialized.value[0] as LoadedStageConfig;
  const fileCompletion = afterCompletionForStage(loaded.value);
  return loadSuccess({
    stageConfig: stage,
    file: stageFile,
    stageId: stage.id,
    stageVersionHash: stageVersionHash(stage, fileCompletion),
    ...(fileCompletion !== undefined ? { completion: fileCompletion } : {}),
    inputSchema: stage.clone_input_schema,
    outputSchema: stage.payload_schema,
    modelResolved: stage.model,
    modelTier: stage.model_tier ?? "global",
  });
}
