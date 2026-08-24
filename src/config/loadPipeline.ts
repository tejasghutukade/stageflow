import { access } from "node:fs/promises";
import path from "node:path";
import type { LoadedPipeline, PipelineConfig } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { loadStageOutcome } from "./loadStage.js";
import { readYamlObject } from "./readYamlObject.js";
import { extractPipelineStageIds, resolvePipelineDag } from "./resolvePipelineDag.js";
import type { ValidationFinding } from "./validateCatalog.js";
import {
  findingStageIdFilenameMismatch,
  findingsFromLoadIssues,
} from "./validateCatalog.js";

export type { LoadedPipeline } from "../types/pipeline.js";
export type { LoadIssue, LoadOutcome } from "./loadOutcome.js";

export type LoadPipelineValidatedResult =
  | { ok: true; loaded: LoadedPipeline }
  | { ok: false; findings: ValidationFinding[] };

async function resolvePipelinePath(nameOrPath: string, cwd: string): Promise<string> {
  const direct = path.resolve(cwd, nameOrPath);
  try {
    await access(direct);
    return direct;
  } catch {
    const candidate = path.resolve(cwd, "pipelines", `${nameOrPath}.yaml`);
    await access(candidate);
    return candidate;
  }
}

export async function loadPipelineOutcome(
  nameOrPath: string,
  options: { cwd?: string; stagesDir?: string } = {},
): Promise<LoadOutcome<LoadedPipeline>> {
  const cwd = options.cwd ?? process.cwd();
  const stagesDir = options.stagesDir ?? path.join(cwd, "stages");

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

  let raw: Record<string, unknown>;
  try {
    raw = await readYamlObject(pipelinePath);
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

  if (typeof raw?.id !== "string" || !Array.isArray(raw.stages)) {
    return loadFailure([
      {
        code: "pipeline.invalid_shape",
        message: `Invalid pipeline ${pipelinePath}: id and stages[] are required`,
        category: "pipeline",
      },
    ]);
  }

  const pipelineId = raw.id;
  const ctx = { pipelineId: raw.id, path: pipelinePath };

  let stageIds: string[];
  let dag: LoadedPipeline["dag"];
  try {
    const resolved = resolvePipelineDag(raw.stages, ctx);
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

  const pipeline: PipelineConfig = {
    id: raw.id,
    stages: stageIds,
  };

  const stages: StageConfig[] = [];
  for (const stageId of pipeline.stages) {
    const stagePath = path.join(stagesDir, `${stageId}.yaml`);
    const stageOutcome = await loadStageOutcome(stagePath);
    if (!stageOutcome.ok) {
      const message = `Pipeline ${pipeline.id} references missing stage "${stageId}" at ${stagePath}`;
      return loadFailure([
        {
          code: "pipeline.missing_stage",
          message,
          category: "pipeline",
          pipelineId,
        },
      ]);
    }
    stages.push(stageOutcome.value);
  }

  return loadSuccess({ pipeline, stages, dag });
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
  options: { cwd?: string; stagesDir?: string; validateStages?: boolean } = {},
): Promise<LoadPipelineValidatedResult> {
  const cwd = options.cwd ?? process.cwd();
  const stagesDir = options.stagesDir ?? path.join(cwd, "stages");
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

  const referencedStageIds = new Set<string>();
  try {
    const raw = await readYamlObject(pipelinePath);
    if (typeof raw?.id === "string" && Array.isArray(raw.stages)) {
      const stageIds = extractPipelineStageIds(raw.stages);
      if (stageIds) {
        for (const stageId of stageIds) {
          referencedStageIds.add(stageId);
        }
      }
    }
  } catch {
    // loadPipelineOutcome will report read errors
  }

  const outcome = await loadPipelineOutcome(nameOrPath, { cwd, stagesDir });
  const findings: ValidationFinding[] = [];

  if (!outcome.ok) {
    findings.push(...findingsFromLoadIssues(cwd, pipelinePath, outcome.issues));
    if (validateStages) {
      for (const stageId of referencedStageIds) {
        const stagePath = path.join(stagesDir, `${stageId}.yaml`);
        findings.push(...(await validateStageFile(cwd, stagePath)));
      }
    }
    return { ok: false, findings };
  }

  if (validateStages) {
    for (const stageId of outcome.value.pipeline.stages) {
      const stagePath = path.join(stagesDir, `${stageId}.yaml`);
      findings.push(...(await validateStageFile(cwd, stagePath)));
    }
  }

  if (findings.some((finding) => finding.severity === "error")) {
    return { ok: false, findings };
  }

  return { ok: true, loaded: outcome.value };
}

export async function loadPipeline(
  nameOrPath: string,
  options: { cwd?: string; stagesDir?: string } = {},
): Promise<LoadedPipeline> {
  const outcome = await loadPipelineOutcome(nameOrPath, options);
  if (!outcome.ok) {
    throw new Error(outcome.issues[0].message);
  }
  return outcome.value;
}
