import path from "node:path";
import { checkDatasetAgainstStage } from "../config/datasetStageCheck.js";
import type { DatasetCase } from "../config/datasetTypes.js";
import { loadDatasetFile, parseDatasetCases } from "../config/loadDataset.js";
import {
  EVAL_DEFAULT_CONCURRENCY,
  EVAL_DEFAULT_MAX_COST_USD,
  EVAL_DEFAULT_PASS_THRESHOLD,
  EVAL_DEFAULT_REPEATS,
  graderHash,
  loadEvalOutcome,
  parseEvalOutcome,
  resolveEvalPaths,
  type LoadedEval,
} from "../config/loadEval.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import {
  resolveEvalTarget,
  stageDefinition,
  type ResolvedEvalTarget,
} from "../config/resolveEvalTarget.js";
import type { ValidationFinding } from "../config/validateCatalog.js";
import {
  EVAL_LARGE_RUN,
  EVAL_TOO_LARGE_RUN,
  evalFinding,
  evalFindingsFromIssues,
  validateEval,
} from "../config/validateEval.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { EVAL_LIMITS } from "./constants.js";
import {
  buildComponents,
  buildSnapshot,
  computeFingerprint,
  type ConfigComponents,
  type ConfigSnapshot,
  type SnapshotOverrides,
} from "./snapshot.js";
import type { EvalPlan, PlanCase, ResolvedGrader } from "./types.js";

export type EvalOverrides = {
  repeats?: number;
  judge?: string;
  model?: string;
  max_cost_usd?: number;
  case_ids?: string[];
  tags?: string[];
  only_failed_from?: string;
};

export type BuildEvalPlanInput = {
  projectRoot: string;
  evalPath: string;
  /** Eval file text to use instead of reading `evalPath`; the path still sets where relative paths resolve. */
  evalText?: string;
  overrides?: EvalOverrides;
  /** Cases to use instead of reading the dataset file; the definition's dataset path is then only a label. */
  datasetCases?: readonly unknown[];
  evalRunId: string;
  /** Case ids with at least one failed executed result in the given eval run; undefined when the run is unknown. */
  failedCaseIdsOf?: (evalRunId: string) => string[] | undefined | Promise<string[] | undefined>;
  engine: { name: string; version: string; nodeVersion: string };
  /** Grader id to the ordinal of its current hash, from the run store; defaults to 1. */
  graderOrdinals?: Record<string, number>;
  isKnownModel?: (id: string) => Promise<boolean>;
  /** Reserved: the snapshot carries no timestamp today. */
  now?: Date;
};

export type BuildEvalPlanResult =
  | {
      ok: true;
      plan: EvalPlan;
      snapshot: ConfigSnapshot;
      fingerprint: string;
      components: ConfigComponents;
      skippedCaseIds: string[];
      findings: ValidationFinding[];
    }
  | { ok: false; code: "EVAL_INVALID"; findings: ValidationFinding[] };

const SELECTION_KEYS = ["case_ids", "tags", "only_failed_from"] as const;
const RUN_SIZE_CODES = new Set(["eval.large_run", "eval.too_large_run"]);

function posix(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

function schemaHash(schema: unknown): string | null {
  return schema === undefined ? null : sha256Hex(canonicalJson(schema));
}

function checkOverrides(relPath: string, overrides: EvalOverrides): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const bad = (message: string): void => {
    out.push(evalFinding(relPath, "error", "eval.invalid_field", message));
  };
  const { repeats, max_cost_usd: maxCost, judge, model } = overrides;
  if (
    repeats !== undefined &&
    (!Number.isInteger(repeats) ||
      repeats < EVAL_LIMITS.repeats.min ||
      repeats > EVAL_LIMITS.repeats.max)
  ) {
    bad(`Override "repeats" must be an integer from ${EVAL_LIMITS.repeats.min} to ${EVAL_LIMITS.repeats.max}`);
  }
  if (maxCost !== undefined && !(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0)) {
    bad(`Override "max_cost_usd" must be a number greater than 0`);
  }
  for (const [key, value] of [["judge", judge], ["model", model]] as const) {
    if (value !== undefined && (typeof value !== "string" || value === "")) {
      bad(`Override "${key}" must be a model id string`);
    }
  }
  const chosen = SELECTION_KEYS.filter((key) => overrides[key] !== undefined);
  if (chosen.length > 1) {
    bad(`Case selection overrides are mutually exclusive; got ${chosen.join(", ")}`);
  }
  if (overrides.case_ids !== undefined && overrides.case_ids.length === 0) {
    bad(`Override "case_ids" must not be empty`);
  }
  if (overrides.tags !== undefined && overrides.tags.length === 0) {
    bad(`Override "tags" must not be empty`);
  }
  return out;
}

function withOverrides(loaded: LoadedEval, overrides: EvalOverrides): LoadedEval {
  const defaults = {
    ...loaded.file.defaults,
    ...(overrides.repeats !== undefined ? { repeats: overrides.repeats } : {}),
    ...(overrides.judge !== undefined ? { judge: overrides.judge } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.max_cost_usd !== undefined ? { max_cost_usd: overrides.max_cost_usd } : {}),
  };
  const graders = loaded.graders.map((grader): ResolvedGrader => {
    if (grader.type !== "rubric" || overrides.judge === undefined) return grader;
    const raw = loaded.file.graders.find((g) => g.id === grader.id);
    if (raw?.type === "rubric" && raw.judge !== undefined) return grader;
    const { hash: _old, ...rest } = { ...grader, judge: overrides.judge };
    return { ...rest, hash: graderHash(rest) };
  });
  return { ...loaded, file: { ...loaded.file, defaults }, graders };
}

function selectCases(
  cases: readonly DatasetCase[],
  overrides: EvalOverrides,
  failedIds: ReadonlySet<string> | undefined,
): DatasetCase[] {
  if (overrides.case_ids !== undefined) {
    const wanted = new Set(overrides.case_ids);
    return cases.filter((c) => wanted.has(c.id));
  }
  if (overrides.tags !== undefined) {
    const wanted = new Set(overrides.tags);
    return cases.filter((c) => (c.tags ?? []).some((tag) => wanted.has(tag)));
  }
  if (failedIds !== undefined) return cases.filter((c) => failedIds.has(c.id));
  return [...cases];
}

function evalDefinition(loaded: LoadedEval, projectRoot: string): Record<string, unknown> {
  const { file } = loaded;
  const paths = resolveEvalPaths(file, loaded.path);
  const rel = (abs: string | undefined): string | undefined =>
    abs === undefined ? undefined : posix(projectRoot, abs);
  const defaults = file.defaults ?? {};
  return JSON.parse(
    JSON.stringify({
      version: file.version,
      id: file.id,
      name: file.name ?? file.id,
      description: file.description,
      type: file.type ?? "capability",
      target: {
        kind: file.target.kind,
        pipeline: rel(paths.pipelinePath),
        stage: file.target.stage,
        file: rel(paths.stageFile),
      },
      dataset: rel(paths.datasetPath),
      task: file.task,
      defaults: {
        repeats: defaults.repeats ?? EVAL_DEFAULT_REPEATS,
        judge: defaults.judge,
        pass_threshold: defaults.pass_threshold ?? EVAL_DEFAULT_PASS_THRESHOLD,
        max_cost_usd: defaults.max_cost_usd ?? EVAL_DEFAULT_MAX_COST_USD,
        concurrency: defaults.concurrency ?? EVAL_DEFAULT_CONCURRENCY,
        model: defaults.model,
      },
      graders: file.graders.map((g) => ({ ...g, weight: g.weight ?? 1, must_pass: g.must_pass ?? false })),
      budget: file.budget,
    }),
  ) as Record<string, unknown>;
}

export async function buildEvalPlan(input: BuildEvalPlanInput): Promise<BuildEvalPlanResult> {
  const { projectRoot } = input;
  const overrides = input.overrides ?? {};
  const evalAbs = path.resolve(projectRoot, input.evalPath);
  const evalRel = posix(projectRoot, evalAbs);
  const fail = (findings: ValidationFinding[]): BuildEvalPlanResult => ({
    ok: false,
    code: "EVAL_INVALID",
    findings,
  });

  let outcome;
  if (input.evalText !== undefined) {
    const parsed = parseEvalOutcome(input.evalText, evalAbs, projectRoot);
    outcome = parsed.ok
      ? { ...parsed, value: { ...parsed.value, fileHash: sha256Hex(input.evalText) } }
      : parsed;
  } else {
    outcome = await loadEvalOutcome(evalAbs, projectRoot);
  }
  if (!outcome.ok) return fail(evalFindingsFromIssues(evalRel, outcome.issues));
  const base = outcome.value;

  const overrideFindings = checkOverrides(base.relPath, overrides);
  if (overrideFindings.length > 0) return fail(overrideFindings);

  let failedIds: Set<string> | undefined;
  if (overrides.only_failed_from !== undefined) {
    const ids = await input.failedCaseIdsOf?.(overrides.only_failed_from);
    if (ids === undefined) {
      return fail([
        evalFinding(
          base.relPath,
          "error",
          "eval.invalid_field",
          `Override "only_failed_from": eval run "${overrides.only_failed_from}" was not found for this eval`,
        ),
      ]);
    }
    failedIds = new Set(ids);
  }

  const loaded = withOverrides(base, overrides);
  const { file } = loaded;
  const paths = resolveEvalPaths(file, loaded.path);
  const dataset =
    input.datasetCases !== undefined
      ? {
          path: paths.datasetPath,
          relPath: posix(projectRoot, paths.datasetPath),
          format: undefined,
          ...parseDatasetCases(input.datasetCases, { path: posix(projectRoot, paths.datasetPath) }),
        }
      : await loadDatasetFile(paths.datasetPath, { root: projectRoot });

  const validation = await validateEval(loaded, {
    projectRoot,
    datasetReport: dataset,
    ...(input.datasetCases !== undefined ? { datasetInline: true } : {}),
    ...(input.isKnownModel ? { isKnownModel: input.isKnownModel } : {}),
  });
  const findings = [...validation.filter((f) => !RUN_SIZE_CODES.has(f.code)), ...dataset.findings];
  if (findings.some((f) => f.severity === "error")) return fail(findings);

  const targetOutcome = await resolveEvalTarget(file, loaded.path, projectRoot);
  if (!targetOutcome.ok) return fail(evalFindingsFromIssues(loaded.relPath, targetOutcome.issues));
  const target: ResolvedEvalTarget = targetOutcome.value;

  if (overrides.case_ids !== undefined) {
    const known = new Set(dataset.cases.map((c) => c.id));
    const unknown = overrides.case_ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return fail([
        ...findings,
        evalFinding(
          loaded.relPath,
          "error",
          "eval.invalid_field",
          `Override "case_ids" names ${unknown.length} case(s) not in the dataset; first: ${unknown[0]}`,
        ),
      ]);
    }
  }

  const checks = new Map(
    checkDatasetAgainstStage(dataset.cases, target.inputSchema).map((r) => [r.caseId, r.valid]),
  );
  const validCases = dataset.cases.filter((c) => checks.get(c.id) !== false);
  const selected = selectCases(dataset.cases, overrides, failedIds);
  const skippedCaseIds = selected.filter((c) => checks.get(c.id) === false).map((c) => c.id);
  const runCases = selected.filter((c) => checks.get(c.id) !== false);

  const positionOf = new Map(dataset.cases.map((c, i) => [c.id, i]));
  const planCases: PlanCase[] = runCases.map((c) => ({
    id: c.id,
    position: positionOf.get(c.id) ?? 0,
    ...(c.title !== undefined ? { title: c.title } : {}),
    ...(c.goal !== undefined ? { goal: c.goal } : {}),
    input: c.input,
    ...(c.expected !== undefined ? { expected: c.expected } : {}),
    tags: c.tags ?? [],
    ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
  }));

  const repeats = file.defaults?.repeats ?? EVAL_DEFAULT_REPEATS;
  const results = planCases.length * repeats;
  const sizeFindings: ValidationFinding[] = [];
  if (planCases.length === 0) {
    if (!findings.some((f) => f.code === "eval.no_valid_cases")) {
      sizeFindings.push(
        evalFinding(
          loaded.relPath,
          "error",
          "eval.no_valid_cases",
          `No valid cases are left to run after case selection and skipping`,
        ),
      );
    }
  } else if (results > EVAL_LIMITS.maxResultsPerRun) {
    sizeFindings.push(
      evalFinding(
        loaded.relPath,
        "error",
        "eval.too_large_run",
        `${planCases.length} case(s) x ${repeats} repeat(s) = ${results} results, over the ${EVAL_TOO_LARGE_RUN} limit`,
      ),
    );
  } else if (results > EVAL_LARGE_RUN) {
    sizeFindings.push(
      evalFinding(
        loaded.relPath,
        "warning",
        "eval.large_run",
        `${planCases.length} case(s) x ${repeats} repeat(s) = ${results} results, over ${EVAL_LARGE_RUN}`,
      ),
    );
  }
  const allFindings = [...findings, ...sizeFindings];
  if (sizeFindings.some((f) => f.severity === "error")) return fail(allFindings);

  const defaults = file.defaults ?? {};
  const passThreshold = defaults.pass_threshold ?? EVAL_DEFAULT_PASS_THRESHOLD;
  const concurrency = defaults.concurrency ?? EVAL_DEFAULT_CONCURRENCY;
  const maxCostUsd = defaults.max_cost_usd ?? EVAL_DEFAULT_MAX_COST_USD;
  const judge = defaults.judge ?? "";
  const modelOverride = defaults.model;
  const stageModel = modelOverride ?? target.modelResolved;
  const relOrUndef = (abs: string | undefined): string | undefined =>
    abs === undefined ? undefined : posix(projectRoot, abs);
  const pipelineRel = relOrUndef(target.pipelinePath);
  const fileRel = relOrUndef(target.file);
  const { stageId } = target;

  const components = buildComponents({
    stageVersionHash: target.stageVersionHash,
    model: stageModel,
    datasetHash: dataset.contentHash,
    caseIds: runCases.length < validCases.length ? runCases.map((c) => c.id) : null,
    graders: loaded.graders,
    judge,
    repeats,
    passThreshold,
    engine: input.engine,
  });
  const fingerprint = computeFingerprint(components);

  const hasRubric = loaded.graders.some((g) => g.type === "rubric");
  const snapshotOverrides: SnapshotOverrides = {
    repeats: overrides.repeats ?? null,
    judge: overrides.judge ?? null,
    model: overrides.model ?? null,
    max_cost_usd: overrides.max_cost_usd ?? null,
    case_ids: overrides.case_ids ?? null,
    tags: overrides.tags ?? null,
    only_failed_from: overrides.only_failed_from ?? null,
  };
  const snapshot = buildSnapshot({
    evalId: loaded.id,
    evalPath: loaded.relPath,
    evalHash: loaded.fileHash,
    evalDefinition: evalDefinition(base, projectRoot),
    overrides: snapshotOverrides,
    target: {
      pipeline_path: pipelineRel ?? null,
      stage_id: stageId ?? null,
      file: fileRel ?? null,
      stage_version_hash: target.stageVersionHash,
      stage_definition: JSON.parse(
        JSON.stringify(stageDefinition(target.stageConfig, target.completion)),
      ) as Record<string, unknown>,
      model: stageModel,
      model_tier: target.modelTier,
      input_schema_hash: schemaHash(target.inputSchema),
      output_schema_hash: schemaHash(target.outputSchema),
    },
    dataset: {
      path: posix(projectRoot, paths.datasetPath),
      hash: dataset.contentHash,
      format: dataset.format ?? "jsonl",
      case_count: dataset.cases.length,
      cases_run: planCases.length,
      cases_skipped: skippedCaseIds.length,
      skipped_case_ids: skippedCaseIds,
    },
    graders: loaded.graders.map((g) => ({
      id: g.id,
      type: g.type,
      hash: g.hash,
      version_ordinal: input.graderOrdinals?.[g.id] ?? 1,
      weight: g.weight,
      must_pass: g.mustPass,
    })),
    settings: {
      repeats,
      pass_threshold: passThreshold,
      judge,
      judge_same_as_stage: hasRubric && judge !== "" && judge === stageModel,
      max_cost_usd: maxCostUsd,
      concurrency,
      suite_type: file.type ?? "capability",
    },
    engine: input.engine,
    stageflowVersion: PACKAGE_VERSION,
  });

  const plan: EvalPlan = {
    evalRunId: input.evalRunId,
    projectRoot,
    evalId: loaded.id,
    target: {
      kind: "stage",
      ...(pipelineRel !== undefined ? { pipelinePath: pipelineRel } : {}),
      ...(pipelineRel !== undefined && stageId !== undefined ? { stageId } : {}),
      ...(fileRel !== undefined ? { file: fileRel } : {}),
    },
    targetVersionHash: target.stageVersionHash,
    ...(target.outputSchema !== undefined ? { outputSchema: target.outputSchema } : {}),
    stageModel,
    task: { ...file.task },
    cases: planCases,
    graders: loaded.graders,
    repeats,
    passThreshold,
    concurrency,
    maxCostUsd,
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(file.budget !== undefined
      ? {
          budget: {
            ...(file.budget.latency_ms !== undefined ? { latencyMs: file.budget.latency_ms } : {}),
            ...(file.budget.cost_usd !== undefined ? { costUsd: file.budget.cost_usd } : {}),
          },
        }
      : {}),
  };

  return { ok: true, plan, snapshot, fingerprint, components, skippedCaseIds, findings: allFindings };
}
