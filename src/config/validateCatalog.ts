import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadPipelineOutcome, loadPipelineValidated } from "./loadPipeline.js";
import type { LoadIssue } from "./loadOutcome.js";
import { loadStageOutcome } from "./loadStage.js";
import { readYamlObject } from "./readYamlObject.js";
import { extractPipelineStageIds } from "./resolvePipelineDag.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationCategory = "pipeline" | "stage" | "catalog";

export type ValidationFindingCode =
  | "pipeline.invalid_shape"
  | "pipeline.dag_error"
  | "pipeline.missing_stage"
  | "pipeline.load_error"
  | "stage.invalid_shape"
  | "stage.invalid_payload_schema"
  | "stage.invalid_gate_kinds"
  | "stage.invalid_skill"
  | "stage.load_error"
  | "stage.id_filename_mismatch"
  | "catalog.duplicate_pipeline_id"
  | "catalog.orphan_stage";

export type ValidationFinding = {
  severity: ValidationSeverity;
  code: ValidationFindingCode | string;
  path: string;
  message: string;
  category: ValidationCategory;
  pipelineId?: string;
  stageId?: string;
};

export type ValidationScope = "full" | "pipeline";

export type ValidateCatalogOptions = {
  cwd?: string;
  stagesDir?: string;
  scope: ValidationScope;
  pipeline?: string;
  strict?: boolean;
};

export type ValidationResult = {
  scope: ValidationScope;
  ok: boolean;
  summary: { errors: number; warnings: number };
  findings: ValidationFinding[];
};

export function relPath(cwd: string, absPath: string): string {
  return path.relative(cwd, absPath);
}

const SEVERITY_RANK: Record<ValidationSeverity, number> = {
  error: 0,
  warning: 1,
};

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return [...findings].sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    const sevCmp = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevCmp !== 0) return sevCmp;
    const codeCmp = a.code.localeCompare(b.code);
    if (codeCmp !== 0) return codeCmp;
    return a.message.localeCompare(b.message);
  });
}

export function effectiveSeverity(
  finding: ValidationFinding,
  strict: boolean,
): ValidationSeverity {
  if (
    strict &&
    finding.severity === "warning" &&
    finding.code === "catalog.orphan_stage"
  ) {
    return "error";
  }
  return finding.severity;
}

function summarizeFindings(
  findings: ValidationFinding[],
  strict: boolean,
): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const finding of findings) {
    const severity = effectiveSeverity(finding, strict);
    if (severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}

export function buildValidationResult(
  scope: ValidationScope,
  findings: ValidationFinding[],
  strict: boolean,
): ValidationResult {
  const sorted = sortFindings(findings);
  const summary = summarizeFindings(sorted, strict);
  const ok = summary.errors === 0;
  return { scope, ok, summary, findings: sorted };
}

type FindingBase = {
  cwd: string;
  absPath: string;
  message: string;
  code: ValidationFindingCode | string;
  category: ValidationCategory;
  pipelineId?: string;
  stageId?: string;
};

function baseFinding(fields: FindingBase, severity: ValidationSeverity): ValidationFinding {
  return {
    severity,
    code: fields.code,
    path: relPath(fields.cwd, fields.absPath),
    message: fields.message,
    category: fields.category,
    ...(fields.pipelineId !== undefined ? { pipelineId: fields.pipelineId } : {}),
    ...(fields.stageId !== undefined ? { stageId: fields.stageId } : {}),
  };
}

function findingPipelineError(
  cwd: string,
  absPath: string,
  message: string,
  code: ValidationFindingCode,
  pipelineId?: string,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message,
      code,
      category: "pipeline",
      pipelineId,
    },
    "error",
  );
}

function findingStageError(
  cwd: string,
  absPath: string,
  message: string,
  code: ValidationFindingCode,
  stageId?: string,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message,
      code,
      category: "stage",
      stageId,
    },
    "error",
  );
}

export function findingsFromLoadIssues(
  cwd: string,
  absPath: string,
  issues: LoadIssue[],
): ValidationFinding[] {
  return issues.flatMap((issue) => {
    if (issue.category === "pipeline") {
      return [
        findingPipelineError(
          cwd,
          absPath,
          issue.message,
          issue.code,
          issue.pipelineId,
        ),
      ];
    }
    if (issue.category === "stage") {
      return [
        findingStageError(cwd, absPath, issue.message, issue.code, issue.stageId),
      ];
    }
    return [];
  });
}

export function findingStageIdFilenameMismatch(
  cwd: string,
  absPath: string,
  fileStem: string,
  declaredId: string,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message: `Stage id "${declaredId}" does not match filename stem "${fileStem}"`,
      code: "stage.id_filename_mismatch",
      category: "stage",
      stageId: declaredId,
    },
    "error",
  );
}

function findingCatalogDuplicatePipelineId(
  cwd: string,
  absPath: string,
  pipelineId: string,
  conflictingPaths: string[],
): ValidationFinding {
  const relConflicts = conflictingPaths.map((p) => relPath(cwd, p));
  return baseFinding(
    {
      cwd,
      absPath,
      message: `Duplicate pipeline id "${pipelineId}" declared in: ${relConflicts.join(", ")}`,
      code: "catalog.duplicate_pipeline_id",
      category: "catalog",
      pipelineId,
    },
    "error",
  );
}

function findingCatalogOrphanStage(
  cwd: string,
  absPath: string,
  stageId: string,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message: `Stage "${stageId}" is not referenced by any pipeline`,
      code: "catalog.orphan_stage",
      category: "catalog",
      stageId,
    },
    "warning",
  );
}

async function listYamlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
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

type PipelineValidationResult = {
  findings: ValidationFinding[];
  pipelineId?: string;
  referencedStageIds: Set<string>;
};

async function validatePipelineFile(
  pipelinePath: string,
  options: { cwd: string; stagesDir: string; validateStages: boolean },
): Promise<PipelineValidationResult> {
  const { cwd, stagesDir, validateStages } = options;
  const findings: ValidationFinding[] = [];
  const referencedStageIds = new Set<string>();

  let pipelineId: string | undefined;
  try {
    const raw = await readYamlObject(pipelinePath);
    if (typeof raw?.id === "string") {
      pipelineId = raw.id;
      if (Array.isArray(raw.stages)) {
        const stageIds = extractPipelineStageIds(raw.stages);
        if (stageIds) {
          for (const stageId of stageIds) {
            referencedStageIds.add(stageId);
          }
        }
      }
    }
  } catch {
    // loadPipelineOutcome will report read errors
  }

  const outcome = await loadPipelineOutcome(pipelinePath, { cwd, stagesDir });
  if (!outcome.ok) {
    findings.push(...findingsFromLoadIssues(cwd, pipelinePath, outcome.issues));
    if (validateStages) {
      for (const stageId of referencedStageIds) {
        const stagePath = path.join(stagesDir, `${stageId}.yaml`);
        findings.push(...(await validateStageFile(cwd, stagePath)));
      }
    }
    return { findings, pipelineId, referencedStageIds };
  }

  for (const stageId of outcome.value.pipeline.stages) {
    referencedStageIds.add(stageId);
    if (validateStages) {
      const stagePath = path.join(stagesDir, `${stageId}.yaml`);
      findings.push(...(await validateStageFile(cwd, stagePath)));
    }
  }

  return { findings, pipelineId: outcome.value.pipeline.id, referencedStageIds };
}

async function collectPipelineIds(
  pipelinesDir: string,
): Promise<Map<string, string[]>> {
  const files = await listYamlFiles(pipelinesDir);
  const idToPaths = new Map<string, string[]>();

  for (const filePath of files) {
    try {
      const raw = await readYamlObject(filePath);
      if (typeof raw?.id !== "string") continue;
      const existing = idToPaths.get(raw.id) ?? [];
      existing.push(filePath);
      idToPaths.set(raw.id, existing);
    } catch {
      // unreadable files handled in pipeline validation loop
    }
  }

  return idToPaths;
}

function findingsForDuplicatePipelineIds(
  cwd: string,
  idToPaths: Map<string, string[]>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const [pipelineId, paths] of idToPaths) {
    if (paths.length <= 1) continue;
    for (const filePath of paths) {
      findings.push(
        findingCatalogDuplicatePipelineId(cwd, filePath, pipelineId, paths),
      );
    }
  }
  return findings;
}

async function collectReferencedStageIds(pipelinesDir: string): Promise<Set<string>> {
  const files = await listYamlFiles(pipelinesDir);
  const referenced = new Set<string>();

  for (const filePath of files) {
    try {
      const raw = await readYamlObject(filePath);
      if (typeof raw?.id !== "string" || !Array.isArray(raw.stages)) continue;
      const stageIds = extractPipelineStageIds(raw.stages);
      if (!stageIds) continue;
      for (const stageId of stageIds) {
        referenced.add(stageId);
      }
    } catch {
      // skip unreadable
    }
  }

  return referenced;
}

async function findingsForOrphanStages(
  cwd: string,
  stagesDir: string,
  referencedStageIds: Set<string>,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const stageFiles = await listYamlFiles(stagesDir);

  for (const stagePath of stageFiles) {
    const stageId = path.basename(stagePath, ".yaml");
    if (referencedStageIds.has(stageId)) continue;
    findings.push(findingCatalogOrphanStage(cwd, stagePath, stageId));
    findings.push(...(await validateStageFile(cwd, stagePath)));
  }

  return findings;
}

export async function validateCatalog(
  options: ValidateCatalogOptions,
): Promise<ValidationResult> {
  const cwd = options.cwd ?? process.cwd();
  const stagesDir = options.stagesDir ?? path.join(cwd, "stages");
  const strict = options.strict ?? false;
  const pipelinesDir = path.join(cwd, "pipelines");

  if (options.scope === "pipeline" && !options.pipeline) {
    throw new Error("validateCatalog: pipeline is required when scope is \"pipeline\"");
  }

  const allFindings: ValidationFinding[] = [];

  if (options.scope === "pipeline") {
    const result = await loadPipelineValidated(options.pipeline!, {
      cwd,
      stagesDir,
      validateStages: true,
    });
    if (!result.ok) {
      allFindings.push(...result.findings);
    }
  } else {
    const referencedStageIds = await collectReferencedStageIds(pipelinesDir);
    const pipelineFiles = await listYamlFiles(pipelinesDir);

    for (const pipelinePath of pipelineFiles) {
      const result = await validatePipelineFile(pipelinePath, {
        cwd,
        stagesDir,
        validateStages: false,
      });
      allFindings.push(...result.findings);
      for (const stageId of result.referencedStageIds) {
        referencedStageIds.add(stageId);
      }
    }

    const validatedStages = new Set<string>();
    for (const stageId of referencedStageIds) {
      if (validatedStages.has(stageId)) continue;
      validatedStages.add(stageId);
      const stagePath = path.join(stagesDir, `${stageId}.yaml`);
      allFindings.push(...(await validateStageFile(cwd, stagePath)));
    }

    const idToPaths = await collectPipelineIds(pipelinesDir);
    allFindings.push(...findingsForDuplicatePipelineIds(cwd, idToPaths));
    allFindings.push(
      ...(await findingsForOrphanStages(cwd, stagesDir, referencedStageIds)),
    );
  }

  return buildValidationResult(options.scope, allFindings, strict);
}
