import { access } from "node:fs/promises";
import path from "node:path";
import type {
  LoadedPipeline,
  PipelineConfig,
  PipelineStageSource,
  ResolvedPipelineDag,
} from "../types/pipeline.js";
import type { CompletionContract } from "../types/completion.js";
import type { StageConfig } from "../types/stage.js";
import {
  compilePayloadSchema,
  expandPayloadSchemaRefs,
  isPayloadSchemaSubset,
  UnresolvedSchemaRefError,
  type PayloadSchemaMap,
} from "../envelope/payloadSchema.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { mergePipelineStages } from "./mergePipelineIncludes.js";
import {
  normalizePipelineStageEntries,
  toWiringRefs,
} from "./normalizePipelineStageEntry.js";
import { loadStageFromObjectOutcome, loadStageOutcome, afterCompletionForStage } from "./loadStage.js";
import { materializeStageModels } from "./materializeStageModels.js";
import { predecessorEdges } from "./pipelineNeeds.js";
import { resolvePipelineDagFromRefs } from "./resolvePipelineDag.js";
import { recoveryRequiresCompletionIssue } from "./parseCompletionContract.js";
import { validateCompletionContractForStage } from "./validateCompletionContract.js";
import { applyCloneChains } from "./cloneChain.js";
import {
  collectRouteIfSchemaIssues,
  collectRouteIfIllegalCombos,
  collectRouteAllGatedWarnings,
} from "./routeIf.js";

export type { LoadedPipeline } from "../types/pipeline.js";
export type { LoadIssue, LoadOutcome } from "./loadOutcome.js";

function schemaCompileIssue(
  stageId: string,
  field: "payload_schema" | "clone_input_schema",
  err: unknown,
  pipelineId: string,
): LoadIssue {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof UnresolvedSchemaRefError) {
    return {
      code: "stage.unresolved_schema_ref",
      message: `Pipeline ${pipelineId}: stage "${stageId}" ${field}: ${message}`,
      category: "stage",
      stageId,
    };
  }
  return {
    code: field === "payload_schema" ? "stage.invalid_payload_schema" : "stage.invalid_clone_input_schema",
    message: `Pipeline ${pipelineId}: stage "${stageId}" ${field}: ${message}`,
    category: "stage",
    stageId,
  };
}

function attachPipelineSchemas(
  stages: StageConfig[],
  schemas: PayloadSchemaMap | undefined,
  pipelineId: string,
): LoadOutcome<void> {
  const options = schemas !== undefined ? { schemas } : undefined;
  for (const stage of stages) {
    if (stage.payload_schema !== undefined) {
      try {
        compilePayloadSchema(stage.payload_schema, options);
        stage.payload_schema = expandPayloadSchemaRefs(stage.payload_schema, options);
      } catch (err) {
        return loadFailure([schemaCompileIssue(stage.id, "payload_schema", err, pipelineId)]);
      }
    }
    if (stage.clone_input_schema !== undefined) {
      try {
        compilePayloadSchema(stage.clone_input_schema, options);
        stage.clone_input_schema = expandPayloadSchemaRefs(stage.clone_input_schema, options);
      } catch (err) {
        return loadFailure([schemaCompileIssue(stage.id, "clone_input_schema", err, pipelineId)]);
      }
    }
  }
  return loadSuccess(undefined);
}

function checkSequentialIoCompatibility(
  stages: StageConfig[],
  dag: ResolvedPipelineDag,
  pipelineId: string,
  schemas: PayloadSchemaMap | undefined,
  cloneChildIds: ReadonlySet<string> = new Set(),
): LoadOutcome<void> {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));
  const options = schemas !== undefined ? { schemas } : undefined;

  for (const child of stages) {
    if (cloneChildIds.has(child.id)) continue;
    const node = nodeById.get(child.id);
    if (!node) continue;
    for (const parentEdge of predecessorEdges(node)) {
      const parent = stageById.get(parentEdge.id);
      if (!parent?.payload_schema || child.clone_input_schema === undefined) continue;
      if (
        !isPayloadSchemaSubset(child.clone_input_schema, parent.payload_schema, options)
      ) {
        return loadFailure([
          {
            code: "pipeline.io_incompatible",
            message: `Pipeline ${pipelineId}: stage "${child.id}" io.input is not a structural subset of "${parent.id}" io.output`,
            category: "pipeline",
            pipelineId,
          },
        ]);
      }
    }
  }
  return loadSuccess(undefined);
}

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
  cwd: string,
  projectRoot: string = cwd,
  requireIo: boolean = true,
): Promise<LoadOutcome<LoadedPipeline>> {
  const normalizedPipelinePath = path.normalize(path.resolve(pipelinePath));

  const mergeOutcome = await mergePipelineStages(normalizedPipelinePath);
  if (!mergeOutcome.ok) {
    return loadFailure(mergeOutcome.issues);
  }

  const {
    entries: rawEntries,
    pipelineId,
    agent: pipelineAgent,
    model: pipelineModel,
    schemas: pipelineSchemas,
    warnings: mergeWarnings,
  } = mergeOutcome.value;
  const ctx = { pipelineId, path: normalizedPipelinePath };
  const warnings = [...mergeWarnings];

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
  const fileAfterById = new Map<string, CompletionContract>();

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
        deferSchemaRefs: true,
        requireIo,
      });
      if (!inlineOutcome.ok) {
        return loadFailure(inlineOutcome.issues);
      }
      stages.push(inlineOutcome.value);
      stageSources[stageId] = { kind: "inline" };
      continue;
    }

    const stageOutcome = await loadStageOutcome(entry.body.absolutePath, {
      deferSchemaRefs: true,
      requireIo,
    });
    if (!stageOutcome.ok) {
      if (stageOutcome.issues.some((issue) => issue.code === "catalog.mixed_yaml_dialect")) {
        return loadFailure(stageOutcome.issues);
      }
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
    if (stageOutcome.issues) warnings.push(...stageOutcome.issues);

    const fileAfter = afterCompletionForStage(stageOutcome.value);
    if (fileAfter && entry.completion) {
      return loadFailure([
        {
          code: "pipeline.invalid_completion",
          message: `Pipeline ${pipelineId}: stage "${stageId}" after-checks come from both body verify and wrapper completion`,
          category: "pipeline",
          pipelineId,
        },
      ]);
    }
    if (fileAfter && !entry.completion) {
      fileAfterById.set(stageId, fileAfter);
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
      ...(entry.mcp !== undefined ? { mcp: entry.mcp } : {}),
    };
    stages.push(stage);
    stageSources[stageId] = { kind: "file", path: entry.body.absolutePath };
  }

  const cloneChainOutcome = applyCloneChains(stages, wiringRefs, dag, pipelineId);
  if (!cloneChainOutcome.ok) return cloneChainOutcome;
  const cloneChildIds = cloneChainOutcome.value.cloneChildIds;

  const schemaOutcome = attachPipelineSchemas(stages, pipelineSchemas, pipelineId);
  if (!schemaOutcome.ok) return schemaOutcome;

  const routeIfIssues = [
    ...collectRouteIfSchemaIssues(stages, wiringRefs, pipelineId),
    ...collectRouteIfIllegalCombos(wiringRefs, pipelineId),
  ];
  if (routeIfIssues.length > 0) {
    return loadFailure(routeIfIssues);
  }
  warnings.push(...collectRouteAllGatedWarnings(wiringRefs, pipelineId));

  const ioOutcome = checkSequentialIoCompatibility(
    stages,
    dag,
    pipelineId,
    pipelineSchemas,
    cloneChildIds,
  );
  if (!ioOutcome.ok) return ioOutcome;

  if (pipelineModel !== undefined) {
    const inheritingIds = stages
      .filter((stage) => stage.model === undefined)
      .map((stage) => stage.id);
    if (inheritingIds.length > 0) {
      warnings.push({
        code: "pipeline.model_applies",
        message: `Pipeline ${pipelineId}: pipeline-root model now applies to stages that omit model (${inheritingIds.join(", ")})`,
        category: "pipeline",
        pipelineId,
      });
    }
  }

  const materializeOutcome = await materializeStageModels(stages, {
    pipelineModel,
    pipelineId,
    projectRoot,
  });
  if (!materializeOutcome.ok) {
    return loadFailure(materializeOutcome.issues);
  }
  const loadedStages = materializeOutcome.value;

  const pipeline: PipelineConfig = {
    id: pipelineId,
    stages: stageIds,
    ...(pipelineAgent !== undefined ? { agent: pipelineAgent } : {}),
    ...(pipelineModel !== undefined ? { model: pipelineModel } : {}),
    ...(pipelineSchemas !== undefined ? { schemas: pipelineSchemas } : {}),
  };

  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));
  for (const [stageId, after] of fileAfterById) {
    const node = nodeById.get(stageId);
    if (node) node.completion = after;
  }
  for (const node of dag.nodes) {
    if (node.recovery !== undefined && node.completion === undefined) {
      return loadFailure([recoveryRequiresCompletionIssue(node.id)]);
    }
  }
  for (const stage of loadedStages) {
    const completion = nodeById.get(stage.id)?.completion;
    const completionOutcome = validateCompletionContractForStage(stage, completion);
    if (!completionOutcome.ok) return loadFailure(completionOutcome.issues);
  }

  return loadSuccess(
    {
      pipeline,
      stages: loadedStages,
      dag,
      pipelinePath: normalizedPipelinePath,
      stageSources,
    },
    warnings,
  );
}

export async function loadPipelineOutcome(
  nameOrPath: string,
  options: { cwd?: string; projectRoot?: string; requireIo?: boolean } = {},
): Promise<LoadOutcome<LoadedPipeline>> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? cwd;

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

  return loadPipelineFromPath(pipelinePath, cwd, projectRoot, options.requireIo !== false);
}

export async function loadPipeline(
  nameOrPath: string,
  options: { cwd?: string; projectRoot?: string; requireIo?: boolean } = {},
): Promise<LoadedPipeline> {
  const outcome = await loadPipelineOutcome(nameOrPath, options);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
