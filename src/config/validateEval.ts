import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import { EVAL_DEFAULT_REPEATS, resolveEvalPaths, type LoadedEval } from "./loadEval.js";
import type { LoadIssue } from "./loadOutcome.js";
import { resolveEvalTarget, type ResolvedEvalTarget } from "./resolveEvalTarget.js";
import type { ValidationFinding, ValidationSeverity } from "./validateCatalog.js";

export const EVAL_LARGE_RUN = 500;
export const EVAL_TOO_LARGE_RUN = 5000;

/** The slice of the dataset loader's report that eval validation reads. */
export type DatasetReport = {
  path: string;
  relPath: string;
  cases: Array<{
    id: string;
    input: Record<string, unknown>;
    expected?: unknown;
    tags?: string[];
  }>;
  findings: ValidationFinding[];
  contentHash: string;
};

export type ValidateEvalContext = {
  projectRoot: string;
  evals?: ReadonlyArray<{ id: string; absPath: string }>;
  datasetReport?: DatasetReport;
  isKnownModel?: (id: string) => Promise<boolean>;
};

export function evalFinding(
  relPath: string,
  severity: ValidationSeverity,
  code: string,
  message: string,
  location: { line?: number; column?: number } = {},
): ValidationFinding {
  return {
    severity,
    code,
    path: relPath,
    message,
    category: "eval",
    ...(location.line !== undefined ? { line: location.line } : {}),
    ...(location.column !== undefined ? { column: location.column } : {}),
  };
}

export function evalFindingsFromIssues(relPath: string, issues: LoadIssue[]): ValidationFinding[] {
  return issues.flatMap((issue) =>
    issue.category === "eval"
      ? [evalFinding(relPath, issue.severity ?? "error", issue.code, issue.message, issue)]
      : [],
  );
}

function valueAtPath(root: unknown, dotted: string): unknown {
  let current = root;
  for (const segment of dotted.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function datasetFileFinding(
  loaded: LoadedEval,
  datasetPath: string,
  projectRoot: string,
): Promise<ValidationFinding | undefined> {
  const missing = (reason: string): ValidationFinding =>
    evalFinding(
      loaded.relPath,
      "error",
      "eval.dataset_unresolved",
      `Dataset "${loaded.file.dataset}" ${reason}`,
    );
  try {
    const info = await stat(datasetPath);
    if (!info.isFile()) return missing("is not a file");
    const [realFile, realRoot] = await Promise.all([realpath(datasetPath), realpath(projectRoot)]);
    const rel = path.relative(realRoot, realFile);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return missing("resolves outside the project root");
  } catch {
    return missing("was not found");
  }
  return undefined;
}

function stageNeedsCheckout(target: ResolvedEvalTarget): boolean {
  return target.completion?.checks.some((check) => check.type === "checkout_changes") === true;
}

function inputMismatches(
  report: DatasetReport,
  inputSchema: unknown,
): Array<{ caseId: string; message: string }> {
  if (inputSchema === undefined) return [];
  const out: Array<{ caseId: string; message: string }> = [];
  for (const testCase of report.cases) {
    try {
      const message = payloadInstanceMismatch(testCase.input, inputSchema);
      if (message !== undefined) out.push({ caseId: testCase.id, message });
    } catch {
      return [];
    }
  }
  return out;
}

export async function validateEval(
  loaded: LoadedEval,
  ctx: ValidateEvalContext,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const add = (severity: ValidationSeverity, code: string, message: string): void => {
    findings.push(evalFinding(loaded.relPath, severity, code, message));
  };
  const { file } = loaded;

  const sameId = (ctx.evals ?? []).filter(
    (other) => other.id === loaded.id && path.resolve(other.absPath) !== path.resolve(loaded.path),
  );
  if (sameId.length > 0) {
    const others = sameId
      .map((other) => path.relative(ctx.projectRoot, other.absPath).split(path.sep).join("/"))
      .join(", ");
    add("error", "eval.duplicate_id", `Duplicate eval id "${loaded.id}" also declared in: ${others}`);
  }

  const target = await resolveEvalTarget(file, loaded.path, ctx.projectRoot);
  let resolved: ResolvedEvalTarget | undefined;
  if (!target.ok) {
    findings.push(...evalFindingsFromIssues(loaded.relPath, target.issues));
  } else {
    resolved = target.value;
  }

  if (resolved) {
    if (loaded.graders.some((g) => g.type === "schema") && resolved.outputSchema === undefined) {
      add(
        "error",
        "eval.schema_grader_without_output_schema",
        `A schema grader needs the target stage to declare io.output.schema`,
      );
    }
    if ((resolved.stageConfig.gate_kinds?.length ?? 0) > 0) {
      add(
        "warning",
        "eval.stage_has_gates",
        `Target stage declares gate_kinds (${resolved.stageConfig.gate_kinds?.join(", ")}); a case that stops to ask the operator is recorded as an error`,
      );
    }
    if (stageNeedsCheckout(resolved)) {
      add(
        "warning",
        "eval.stage_needs_checkout",
        "Target stage needs a repository checkout, which eval runs do not provide in release 1",
      );
    }
  }

  const stageModel = file.defaults?.model ?? resolved?.modelResolved;
  const unknownChecked = new Set<string>();
  for (const grader of loaded.graders) {
    if (grader.type !== "rubric") continue;
    if (grader.judge === "") {
      add(
        "error",
        "eval.judge_missing",
        `Rubric grader "${grader.id}" has no judge: set defaults.judge or the grader's judge`,
      );
      continue;
    }
    if (ctx.isKnownModel && !unknownChecked.has(grader.judge)) {
      unknownChecked.add(grader.judge);
      if (!(await ctx.isKnownModel(grader.judge))) {
        add(
          "warning",
          "eval.judge_unknown_model",
          `Judge model "${grader.judge}" is not in the model catalog`,
        );
      }
    }
    if (stageModel !== undefined && grader.judge === stageModel) {
      add(
        "warning",
        "eval.judge_same_as_stage",
        `Rubric grader "${grader.id}" uses judge "${grader.judge}", the same model as the stage (self-preference bias)`,
      );
    }
  }

  const paths = resolveEvalPaths(file, loaded.path);
  const datasetProblem = await datasetFileFinding(loaded, paths.datasetPath, ctx.projectRoot);
  if (datasetProblem) {
    findings.push(datasetProblem);
    return findings;
  }

  const report = ctx.datasetReport;
  if (!report) return findings;

  const datasetErrors = report.findings.filter((f) => f.severity === "error");
  if (datasetErrors.length > 0) {
    add(
      "error",
      "eval.dataset_invalid",
      `Dataset ${report.relPath} has ${datasetErrors.length} error(s); first: ${datasetErrors[0]?.message}`,
    );
  }

  const mismatches = resolved ? inputMismatches(report, resolved.inputSchema) : [];
  const skipped = new Set(mismatches.map((m) => m.caseId));
  if (mismatches.length > 0) {
    add(
      "warning",
      "eval.cases_skipped",
      `${mismatches.length} case(s) fail the stage's io.input.schema and will be skipped when a run starts; first: ${mismatches[0]?.caseId}`,
    );
  }

  const runnable = report.cases.filter((c) => !skipped.has(c.id));
  if (datasetErrors.length === 0 && runnable.length === 0) {
    add("error", "eval.no_valid_cases", `Dataset ${report.relPath} has no valid cases to run`);
  }

  for (const grader of loaded.graders) {
    if (grader.type !== "reference") continue;
    const missingIds = runnable
      .filter((c) => {
        const value = valueAtPath(c, grader.expected);
        return value === undefined || value === null;
      })
      .map((c) => c.id);
    if (missingIds.length > 0) {
      add(
        "warning",
        "eval.cases_missing_expected",
        `Reference grader "${grader.id}": ${missingIds.length} of ${runnable.length} case(s) have no value at "${grader.expected}"; first: ${missingIds[0]}`,
      );
    }
  }

  const repeats = file.defaults?.repeats ?? EVAL_DEFAULT_REPEATS;
  const results = runnable.length * repeats;
  if (results > EVAL_TOO_LARGE_RUN) {
    add(
      "error",
      "eval.too_large_run",
      `${runnable.length} case(s) x ${repeats} repeat(s) = ${results} results, over the ${EVAL_TOO_LARGE_RUN} limit`,
    );
  } else if (results > EVAL_LARGE_RUN) {
    add(
      "warning",
      "eval.large_run",
      `${runnable.length} case(s) x ${repeats} repeat(s) = ${results} results, over ${EVAL_LARGE_RUN}`,
    );
  }

  return findings;
}
