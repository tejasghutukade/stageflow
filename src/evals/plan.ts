import path from "node:path";
import { classifyTool } from "../agents/toolRisk.js";
import { checkDatasetAgainstAgent } from "../config/datasetAgentCheck.js";
import { checkDatasetAgainstStage } from "../config/datasetStageCheck.js";
import type { DatasetCase } from "../config/datasetTypes.js";
import { loadDatasetFile, parseDatasetCases } from "../config/loadDataset.js";
import {
  EVAL_AGENT_DEFAULT_CONCURRENCY,
  EVAL_AGENT_DEFAULT_MAX_COST_USD,
  EVAL_DEFAULT_CONCURRENCY,
  EVAL_DEFAULT_MAX_COST_USD,
  EVAL_DEFAULT_PASS_THRESHOLD,
  EVAL_DEFAULT_REPEATS,
  graderHash,
  loadEvalOutcome,
  parseEvalOutcome,
  resolveConversation,
  resolveEvalPaths,
  type LoadedEval,
} from "../config/loadEval.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { resolveAgentTarget, type AgentCatalogPort, type ResolvedAgentTarget } from "../config/resolveAgentTarget.js";
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
import { EVAL_LIMITS, SIMULATOR_PROMPT_VERSION } from "./constants.js";
import {
  buildComponents,
  buildSnapshot,
  computeFingerprint,
  type ConfigComponents,
  type ConfigSnapshot,
  type SnapshotOverrides,
} from "./snapshot.js";
import { planInternalAgent } from "./planInternalAgent.js";
import { isConversationTarget, type EvalFile, type EvalPlan, type PlanCase, type ResolvedGrader } from "./types.js";

export type EvalOverrides = {
  repeats?: number;
  judge?: string;
  model?: string;
  max_cost_usd?: number;
  case_ids?: string[];
  tags?: string[];
  only_failed_from?: string;
  user_model?: string;
  /** Safer-only: `real` to `read_only`/`mocked`, `read_only` to `mocked`. Agent targets only. */
  tools?: "read_only" | "mocked";
  /** Safer-only: `auto_approve_read` to `record_only`/`deny`, `record_only` to `deny`. Agent targets only. */
  approvals?: "deny" | "record_only";
  /** The per-run consent to `conversation.tools: real`; not part of the fingerprint. */
  allow_real_tools?: boolean;
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
  /** Agent service view, needed for agent targets; without it an agent eval cannot be planned. */
  agents?: AgentCatalogPort;
  /** Built-in operator agents, when the Host is showing them. */
  internalAgents?: ReadonlyArray<{ id: string; title: string; playbook: string; tools: string[] }>;
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

const TOOLS_SAFETY: Record<string, number> = { real: 0, read_only: 1, mocked: 2 };
const APPROVALS_SAFETY: Record<string, number> = { auto_approve_read: 0, record_only: 1, deny: 2 };

function checkConversationOverrides(relPath: string, file: EvalFile, overrides: EvalOverrides): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const keys = (["user_model", "tools", "approvals"] as const).filter((key) => overrides[key] !== undefined);
  if (keys.length === 0) return out;
  if (!isConversationTarget(file.target.kind)) {
    out.push(
      evalFinding(
        relPath,
        "error",
        "eval.conversation_not_applicable",
        `Override ${keys.map((k) => `"${k}"`).join(", ")} applies to agent targets only`,
      ),
    );
    return out;
  }
  const current = resolveConversation(file.conversation);
  const bad = (message: string): void => {
    out.push(evalFinding(relPath, "error", "eval.invalid_field", message));
  };
  if (overrides.user_model !== undefined && (typeof overrides.user_model !== "string" || overrides.user_model === "")) {
    bad(`Override "user_model" must be a model id string`);
  }
  if (overrides.tools !== undefined) {
    if (overrides.tools !== "read_only" && overrides.tools !== "mocked") {
      bad(`Override "tools" must be read_only or mocked`);
    } else if (TOOLS_SAFETY[overrides.tools]! < TOOLS_SAFETY[current.tools]!) {
      bad(`Override "tools" ${overrides.tools} would make the tool policy less safe than ${current.tools}`);
    }
  }
  if (overrides.approvals !== undefined) {
    if (overrides.approvals !== "deny" && overrides.approvals !== "record_only") {
      bad(`Override "approvals" must be deny or record_only`);
    } else if (APPROVALS_SAFETY[overrides.approvals]! < APPROVALS_SAFETY[current.approvals]!) {
      bad(`Override "approvals" ${overrides.approvals} would make the approval policy less safe than ${current.approvals}`);
    }
  }
  return out;
}

function withOverrides(loaded: LoadedEval, overrides: EvalOverrides): LoadedEval {
  const conversation =
    overrides.tools !== undefined || overrides.approvals !== undefined
      ? {
          ...loaded.file.conversation,
          ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
          ...(overrides.approvals !== undefined ? { approvals: overrides.approvals } : {}),
        }
      : undefined;
  const defaults = {
    ...loaded.file.defaults,
    ...(overrides.user_model !== undefined ? { user_model: overrides.user_model } : {}),
    ...(overrides.repeats !== undefined ? { repeats: overrides.repeats } : {}),
    ...(overrides.judge !== undefined ? { judge: overrides.judge } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.max_cost_usd !== undefined ? { max_cost_usd: overrides.max_cost_usd } : {}),
  };
  const graders = loaded.graders.map((grader): ResolvedGrader => {
    if ((grader.type !== "rubric" && grader.type !== "goal_reached") || overrides.judge === undefined) return grader;
    const raw = loaded.file.graders.find((g) => g.id === grader.id);
    if ((raw?.type === "rubric" || raw?.type === "goal_reached") && raw.judge !== undefined) return grader;
    const { hash: _old, ...rest } = { ...grader, judge: overrides.judge };
    return { ...rest, hash: graderHash(rest) };
  });
  return {
    ...loaded,
    file: { ...loaded.file, defaults, ...(conversation !== undefined ? { conversation } : {}) },
    graders,
  };
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
  const stageTarget = file.target.kind === "stage" ? file.target : undefined;
  return JSON.parse(
    JSON.stringify({
      version: file.version,
      id: file.id,
      name: file.name ?? file.id,
      description: file.description,
      type: file.type ?? "capability",
      target:
        file.target.kind === "agent"
          ? { kind: "agent", agent: file.target.agent }
          : file.target.kind === "internal_agent"
            ? { kind: "internal_agent", profile: file.target.profile }
            : {
                kind: file.target.kind,
                pipeline: rel(paths.pipelinePath),
                stage: stageTarget?.stage,
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
        ...(isConversationTarget(file.target.kind) && defaults.user_model !== undefined ? { user_model: defaults.user_model } : {}),
      },
      ...(isConversationTarget(file.target.kind) ? { conversation: file.conversation } : {}),
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
  const conversationOverrideFindings = checkConversationOverrides(base.relPath, base.file, overrides);
  if (conversationOverrideFindings.length > 0) return fail(conversationOverrideFindings);

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
    ...(input.agents ? { agents: input.agents } : {}),
  });
  const findings = [...validation.filter((f) => !RUN_SIZE_CODES.has(f.code)), ...dataset.findings];
  if (findings.some((f) => f.severity === "error")) return fail(findings);

  if (file.target.kind === "internal_agent") {
    return planInternalAgent({
      input,
      loaded,
      dataset: {
        path: paths.datasetPath,
        contentHash: dataset.contentHash,
        format: dataset.format,
        cases: dataset.cases,
      },
      findings,
      overrides,
      ...(failedIds ? { failedIds } : {}),
    });
  }

  let agentTarget: ResolvedAgentTarget | undefined;
  let stageTarget: ResolvedEvalTarget | undefined;
  if (file.target.kind === "agent") {
    if (!input.agents) {
      return fail([
        ...findings,
        evalFinding(loaded.relPath, "error", "eval.agents_unavailable", "Agents are unavailable on this host, so an agent eval cannot run"),
      ]);
    }
    const resolved = await resolveAgentTarget(file, projectRoot, input.agents);
    if (!resolved.ok) return fail(evalFindingsFromIssues(loaded.relPath, resolved.issues));
    agentTarget = resolved.value;
  } else {
    const targetOutcome = await resolveEvalTarget(file, loaded.path, projectRoot);
    if (!targetOutcome.ok) return fail(evalFindingsFromIssues(loaded.relPath, targetOutcome.issues));
    stageTarget = targetOutcome.value;
  }
  const conversation = resolveConversation(file.conversation);

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
    (agentTarget
      ? checkDatasetAgainstAgent(dataset.cases, { mode: conversation.mode })
      : checkDatasetAgainstStage(dataset.cases, stageTarget?.inputSchema)
    ).map((r) => [r.caseId, r.valid]),
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
  const concurrency = defaults.concurrency ?? (agentTarget ? EVAL_AGENT_DEFAULT_CONCURRENCY : EVAL_DEFAULT_CONCURRENCY);
  const maxCostUsd = defaults.max_cost_usd ?? (agentTarget ? EVAL_AGENT_DEFAULT_MAX_COST_USD : EVAL_DEFAULT_MAX_COST_USD);
  const judge = defaults.judge ?? "";
  const modelOverride = defaults.model;

  if (agentTarget) {
    return buildAgentResult({
      input,
      loaded,
      base,
      agentTarget,
      conversation,
      planCases,
      runCases,
      validCases,
      skippedCaseIds,
      dataset,
      datasetPath: paths.datasetPath,
      overrides,
      passThreshold,
      concurrency,
      maxCostUsd,
      judge,
      repeats,
      allFindings,
    });
  }
  const target = stageTarget as ResolvedEvalTarget;
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

type AgentResultInput = {
  input: BuildEvalPlanInput;
  loaded: LoadedEval;
  base: LoadedEval;
  agentTarget: ResolvedAgentTarget;
  conversation: ReturnType<typeof resolveConversation>;
  planCases: PlanCase[];
  runCases: readonly DatasetCase[];
  validCases: readonly DatasetCase[];
  skippedCaseIds: string[];
  dataset: { contentHash: string; format?: string | undefined; cases: DatasetCase[] };
  datasetPath: string;
  overrides: EvalOverrides;
  passThreshold: number;
  concurrency: number;
  maxCostUsd: number;
  judge: string;
  repeats: number;
  allFindings: ValidationFinding[];
};

const CONVERSATION_OVERHEAD_MINUTES = 5;

async function buildAgentResult(a: AgentResultInput): Promise<BuildEvalPlanResult> {
  const { input, loaded, agentTarget, conversation, planCases, runCases, validCases, skippedCaseIds, dataset } = a;
  const { projectRoot } = input;
  const { file } = loaded;
  const defaults = file.defaults ?? {};
  const revision = agentTarget.revision;
  if (revision === null) {
    return {
      ok: false,
      code: "EVAL_INVALID",
      findings: [
        ...a.allFindings,
        evalFinding(loaded.relPath, "error", "eval.agents_unavailable", "The agent revision could not be read"),
      ],
    };
  }
  const { definition } = agentTarget;
  const agentModel = agentTarget.modelResolved ?? "";
  const anySimulated = planCases.some(
    (c) => (typeof c.input.mode === "string" ? c.input.mode : conversation.mode) === "simulated",
  );
  const userModel = anySimulated ? (defaults.user_model ?? defaults.judge ?? null) : null;

  const subAgents: Array<{ id: string; revision: number }> = [];
  for (const id of definition.sub_agents) {
    try {
      const detail = await input.agents!.get(projectRoot, id);
      subAgents.push({ id, revision: detail.agent.revision });
    } catch {
      continue;
    }
  }
  const { max_turns, session_minutes, cost_usd, always_on } = definition.limits;
  const effectiveLimits = {
    max_turns: conversation.maxTurns + 1,
    session_minutes:
      Math.ceil((conversation.maxTurns * conversation.turnTimeoutMs) / 60_000) + CONVERSATION_OVERHEAD_MINUTES,
    cost_usd: null,
    always_on: false,
  };

  const components = buildComponents({
    stageVersionHash: agentTarget.definitionHash,
    model: agentModel,
    datasetHash: dataset.contentHash,
    caseIds: runCases.length < validCases.length ? runCases.map((c) => c.id) : null,
    graders: loaded.graders,
    judge: a.judge,
    repeats: a.repeats,
    passThreshold: a.passThreshold,
    engine: input.engine,
    agent: {
      revision,
      mode: conversation.mode,
      max_turns: conversation.maxTurns,
      turn_timeout_ms: conversation.turnTimeoutMs,
      tools: conversation.tools,
      approvals: conversation.approvals,
      read_only_tools: conversation.readOnlyTools,
      user_model: userModel,
      simulator_prompt_version: SIMULATOR_PROMPT_VERSION,
    },
  });
  const fingerprint = computeFingerprint(components);

  const { overrides } = a;
  const hasRubric = loaded.graders.some((g) => g.type === "rubric" || g.type === "goal_reached");
  const plainDefinition = JSON.parse(JSON.stringify(definition)) as Record<string, unknown>;
  const snapshot = buildSnapshot({
    evalId: loaded.id,
    evalPath: loaded.relPath,
    evalHash: loaded.fileHash,
    evalDefinition: evalDefinition(a.base, projectRoot),
    overrides: {
      repeats: overrides.repeats ?? null,
      judge: overrides.judge ?? null,
      model: overrides.model ?? null,
      max_cost_usd: overrides.max_cost_usd ?? null,
      case_ids: overrides.case_ids ?? null,
      tags: overrides.tags ?? null,
      only_failed_from: overrides.only_failed_from ?? null,
      user_model: overrides.user_model ?? null,
      tools: overrides.tools ?? null,
      approvals: overrides.approvals ?? null,
    },
    target: {
      agent_id: agentTarget.agentId,
      revision,
      definition_hash: agentTarget.definitionHash,
      definition: plainDefinition,
      model: agentModel,
      model_tier: "",
      tools: agentTarget.tools.map((tool) => ({
        id: tool.id,
        risk: tool.risk,
        class: classifyTool(definition, tool.id, conversation.readOnlyTools).class,
      })),
      ask_first: agentTarget.askFirst,
      sub_agents: subAgents,
      limits_override: {
        agent: { max_turns, session_minutes, cost_usd, always_on },
        effective: effectiveLimits,
        capture: "full",
        otlp: false,
        groundedness: false,
      },
    },
    dataset: {
      path: posix(projectRoot, a.datasetPath),
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
      repeats: a.repeats,
      pass_threshold: a.passThreshold,
      judge: a.judge,
      judge_same_as_stage: hasRubric && a.judge !== "" && a.judge === agentModel,
      max_cost_usd: a.maxCostUsd,
      concurrency: a.concurrency,
      suite_type: file.type ?? "capability",
      conversation: {
        mode: conversation.mode,
        max_turns: conversation.maxTurns,
        turn_timeout_ms: conversation.turnTimeoutMs,
        tools: conversation.tools,
        approvals: conversation.approvals,
        read_only_tools: conversation.readOnlyTools,
        real_tools_confirmed: conversation.tools === "real" && overrides.allow_real_tools === true,
        user_model: userModel ?? "",
        user_model_from_judge: userModel !== null && defaults.user_model === undefined,
        simulator_prompt_version: SIMULATOR_PROMPT_VERSION,
      },
    },
    engine: input.engine,
    stageflowVersion: PACKAGE_VERSION,
  });

  const plan: EvalPlan = {
    evalRunId: input.evalRunId,
    projectRoot,
    evalId: loaded.id,
    target: { kind: "agent", agentId: agentTarget.agentId, revision },
    targetVersionHash: agentTarget.definitionHash,
    stageModel: agentModel,
    task: {},
    cases: planCases,
    graders: loaded.graders,
    repeats: a.repeats,
    passThreshold: a.passThreshold,
    concurrency: a.concurrency,
    maxCostUsd: a.maxCostUsd,
    ...(defaults.model !== undefined ? { modelOverride: defaults.model } : {}),
    ...(file.budget !== undefined
      ? {
          budget: {
            ...(file.budget.latency_ms !== undefined ? { latencyMs: file.budget.latency_ms } : {}),
            ...(file.budget.cost_usd !== undefined ? { costUsd: file.budget.cost_usd } : {}),
          },
        }
      : {}),
    agent: { definitionHash: agentTarget.definitionHash, definition: plainDefinition },
    conversation,
    userModel,
  };
  return { ok: true, plan, snapshot, fingerprint, components, skippedCaseIds, findings: a.allFindings };
}
