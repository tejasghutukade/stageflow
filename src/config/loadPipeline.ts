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
import { readYamlObject } from "./readYamlObject.js";
import type { ValidationFinding } from "./validateCatalog.js";
import {
  findingStageIdFilenameMismatch,
  findingsFromLoadIssues,
} from "./validateCatalog.js";
import { resolvePipelineDag } from "./resolvePipelineDag.js";

export type { LoadedPipeline } from "../types/pipeline.js";
export type { LoadIssue, LoadOutcome } from "./loadOutcome.js";

export type LoadPipelineValidatedResult =
  | { ok: true; loaded: LoadedPipeline }
  | { ok: false; findings: ValidationFinding[] };

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
    const resolved = resolvePipelineDag(wiringRefs, ctx);
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

    stages.push(stageOutcome.value);
    stageSources[stageId] = { kind: "file", path: entry.body.absolutePath };
  }

  const pipeline: PipelineConfig = {
    id: pipelineId,
    stages: stageIds,
  };

  return loadSuccess({
    pipeline,
    stages,
    dag,
    pipelinePath: normalizedPipelinePath,
    stageSources,
  });
}

async function checkStageIdFilename(
  cwd: string,
  stagePath: string,
): Promise<ValidationFinding | null> {
  const fileStem = path.basename(stagePath, ".yaml");
  try {
    const raw = await readYamlObject(stagePath);
    if (typeof raw?.id === "string" && raw.id !== fileStem) {
      return findingStageIdFilenameMismatch(cwd, stagePath, fileStem, raw.id);
    }
  } catch {
    // loadStageOutcome will report read errors
  }
  return null;
}

async function validateStageFile(
  cwd: string,
  stagePath: string,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const mismatch = await checkStageIdFilename(cwd, stagePath);
  if (mismatch) findings.push(mismatch);

  const outcome = await loadStageOutcome(stagePath);
  if (!outcome.ok) {
    findings.push(...findingsFromLoadIssues(cwd, stagePath, outcome.issues));
    return findings;
  }

  if (!mismatch && path.basename(stagePath, ".yaml") !== outcome.value.id) {
    findings.push(
      findingStageIdFilenameMismatch(
        cwd,
        stagePath,
        path.basename(stagePath, ".yaml"),
        outcome.value.id,
      ),
    );
  }

  return findings;
}

export async function loadPipelineValidated(
  nameOrPath: string,
  options: { cwd?: string; validateStages?: boolean } = {},
): Promise<LoadPipelineValidatedResult> {
  const cwd = options.cwd ?? process.cwd();
  const validateStages = options.validateStages ?? true;

  let pipelinePath: string;
  try {
    pipelinePath = await resolvePipelinePath(nameOrPath, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      findings: findingsFromLoadIssues(cwd, path.resolve(cwd, nameOrPath), [
        {
          code: "pipeline.load_error",
          message,
          category: "pipeline",
        },
      ]),
    };
  }

  const outcome = await loadPipelineOutcome(nameOrPath, { cwd });
  const findings: ValidationFinding[] = [];

  if (!outcome.ok) {
    findings.push(...findingsFromLoadIssues(cwd, pipelinePath, outcome.issues));
    return { ok: false, findings };
  }

  if (validateStages && outcome.value.stageSources) {
    for (const [stageId, source] of Object.entries(outcome.value.stageSources)) {
      if (source.kind === "file") {
        findings.push(...(await validateStageFile(cwd, source.path)));
      } else {
        void stageId;
      }
    }
  }

  if (findings.some((finding) => finding.severity === "error")) {
    return { ok: false, findings };
  }

  return { ok: true, loaded: outcome.value };
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
