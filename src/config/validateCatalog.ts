import path from "node:path";
import { loadPipelineValidated } from "./loadPipeline.js";
import type { LoadIssue } from "./loadOutcome.js";
import { loadTaskOutcome } from "./loadTask.js";
import { readYamlObject } from "./readYamlObject.js";
import { resolveCatalogContext } from "./resolveCatalogContext.js";
import { scanCatalogPaths } from "./scanCatalogPaths.js";
import { manifestPathForProject } from "./loadStageflowManifest.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationCategory = "pipeline" | "stage" | "catalog" | "task";

export type ValidationFindingCode =
  | "pipeline.invalid_shape"
  | "pipeline.dag_error"
  | "pipeline.missing_stage"
  | "pipeline.load_error"
  | "pipeline.string_stage_ref"
  | "pipeline.stage_uses_inline_conflict"
  | "pipeline.stage_missing_body"
  | "pipeline.stage_id_mismatch"
  | "pipeline.include_cycle"
  | "pipeline.include_invalid"
  | "pipeline.include_duplicate_stage"
  | "stage.invalid_shape"
  | "stage.invalid_payload_schema"
  | "stage.invalid_gate_kinds"
  | "stage.invalid_skill"
  | "stage.load_error"
  | "stage.id_filename_mismatch"
  | "task.invalid_shape"
  | "task.load_error"
  | "catalog.duplicate_pipeline_id"
  | "catalog.manifest_missing"
  | "catalog.manifest_invalid"
  | "catalog.empty_catalog"
  | "catalog.manifest_load_error";

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
  return path.relative(cwd, absPath).replace(/\\/g, "/");
}

const STRICT_CATALOG_WARNINGS = new Set<string>([
  "catalog.manifest_missing",
  "catalog.empty_catalog",
]);

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
    STRICT_CATALOG_WARNINGS.has(finding.code)
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
  severity?: ValidationSeverity;
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

function findingTaskError(
  cwd: string,
  absPath: string,
  message: string,
  code: ValidationFindingCode,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message,
      code,
      category: "task",
    },
    "error",
  );
}

function findingCatalog(
  cwd: string,
  absPath: string,
  message: string,
  code: ValidationFindingCode,
  severity: ValidationSeverity,
): ValidationFinding {
  return baseFinding(
    {
      cwd,
      absPath,
      message,
      code,
      category: "catalog",
    },
    severity,
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
          issue.code as ValidationFindingCode,
          issue.pipelineId,
        ),
      ];
    }
    if (issue.category === "stage") {
      return [
        findingStageError(
          cwd,
          absPath,
          issue.message,
          issue.code as ValidationFindingCode,
          issue.stageId,
        ),
      ];
    }
    if (issue.category === "task") {
      return [
        findingTaskError(
          cwd,
          absPath,
          issue.message,
          issue.code as ValidationFindingCode,
        ),
      ];
    }
    if (issue.category === "catalog") {
      const code = issue.code as ValidationFindingCode;
      const severity =
        code === "catalog.manifest_missing" || code === "catalog.empty_catalog"
          ? "warning"
          : "error";
      return [findingCatalog(cwd, absPath, issue.message, code, severity)];
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

function findingManifestMissing(cwd: string, projectRoot: string): ValidationFinding {
  return findingCatalog(
    cwd,
    manifestPathForProject(projectRoot),
    "No stageflow.yaml manifest found at project root",
    "catalog.manifest_missing",
    "warning",
  );
}

function findingEmptyCatalog(
  cwd: string,
  manifestPath: string,
  kind: "pipelines" | "tasks",
): ValidationFinding {
  return findingCatalog(
    cwd,
    manifestPath,
    `Manifest catalog.${kind} is empty`,
    "catalog.empty_catalog",
    "warning",
  );
}

async function collectPipelineIdsFromPaths(
  pipelinePaths: string[],
): Promise<Map<string, string[]>> {
  const idToPaths = new Map<string, string[]>();

  for (const filePath of pipelinePaths) {
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

async function validateManifestAll(
  invocationCwd: string,
): Promise<ValidationFinding[]> {
  const ctx = await resolveCatalogContext(invocationCwd);
  const findings: ValidationFinding[] = [];

  if (ctx.manifestStatus === "not_git" || ctx.manifestStatus === "missing") {
    if (ctx.projectRoot) {
      findings.push(findingManifestMissing(invocationCwd, ctx.projectRoot));
    } else {
      findings.push(
        findingCatalog(
          invocationCwd,
          path.resolve(invocationCwd),
          "Not inside a git repository; no catalog manifest",
          "catalog.manifest_missing",
          "warning",
        ),
      );
    }
    return findings;
  }

  if (ctx.manifestStatus === "invalid") {
    const manifestPath = ctx.projectRoot
      ? manifestPathForProject(ctx.projectRoot)
      : path.resolve(invocationCwd, "stageflow.yaml");
    findings.push(...findingsFromLoadIssues(invocationCwd, manifestPath, ctx.issues));
    return findings;
  }

  const { projectRoot, manifest } = ctx;
  if (!projectRoot || !manifest) {
    return findings;
  }

  if (manifest.manifest.catalog.pipelines.length === 0) {
    findings.push(findingEmptyCatalog(invocationCwd, manifest.path, "pipelines"));
  }
  if (manifest.manifest.catalog.tasks.length === 0) {
    findings.push(findingEmptyCatalog(invocationCwd, manifest.path, "tasks"));
  }

  const pipelinePaths = await scanCatalogPaths(manifest, "pipeline");
  const taskPaths = await scanCatalogPaths(manifest, "task");

  for (const pipelinePath of pipelinePaths) {
    const result = await loadPipelineValidated(pipelinePath, {
      cwd: projectRoot,
      validateStages: true,
    });
    if (!result.ok) {
      findings.push(...result.findings);
    }
  }

  for (const taskPath of taskPaths) {
    const outcome = await loadTaskOutcome(taskPath);
    if (!outcome.ok) {
      findings.push(...findingsFromLoadIssues(projectRoot, taskPath, outcome.issues));
    }
  }

  const idToPaths = await collectPipelineIdsFromPaths(pipelinePaths);
  findings.push(...findingsForDuplicatePipelineIds(projectRoot, idToPaths));

  return findings;
}

export async function validateCatalog(
  options: ValidateCatalogOptions,
): Promise<ValidationResult> {
  const cwd = options.cwd ?? process.cwd();
  const strict = options.strict ?? false;

  if (options.scope === "pipeline" && !options.pipeline) {
    throw new Error("validateCatalog: pipeline is required when scope is \"pipeline\"");
  }

  const allFindings: ValidationFinding[] = [];

  if (options.scope === "pipeline") {
    const result = await loadPipelineValidated(options.pipeline!, {
      cwd,
      validateStages: true,
    });
    if (!result.ok) {
      allFindings.push(...result.findings);
    }
  } else {
    allFindings.push(...(await validateManifestAll(cwd)));
  }

  return buildValidationResult(options.scope, allFindings, strict);
}
