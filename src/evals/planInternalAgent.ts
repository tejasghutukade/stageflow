import path from "node:path";
import { checkDatasetAgainstAgent } from "../config/datasetAgentCheck.js";
import type { DatasetCase } from "../config/datasetTypes.js";
import {
  EVAL_AGENT_DEFAULT_CONCURRENCY,
  EVAL_AGENT_DEFAULT_MAX_COST_USD,
  EVAL_DEFAULT_PASS_THRESHOLD,
  EVAL_DEFAULT_REPEATS,
  resolveConversation,
  resolveEvalPaths,
  type LoadedEval,
} from "../config/loadEval.js";
import type { ValidationFinding } from "../config/validateCatalog.js";
import { EVAL_LARGE_RUN, EVAL_TOO_LARGE_RUN, evalFinding } from "../config/validateEval.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { sha256Hex } from "./canonical.js";
import { EVAL_LIMITS, SIMULATOR_PROMPT_VERSION } from "./constants.js";
import type { BuildEvalPlanInput, BuildEvalPlanResult, EvalOverrides } from "./plan.js";
import { buildComponents, buildSnapshot, computeFingerprint, type SnapshotOverrides } from "./snapshot.js";
import type { EvalPlan, PlanCase } from "./types.js";

type Dataset = {
  path: string;
  contentHash: string;
  format?: string;
  cases: DatasetCase[];
};

function posix(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

function selectCases(cases: readonly DatasetCase[], overrides: EvalOverrides, failedIds: ReadonlySet<string> | undefined): DatasetCase[] {
  if (overrides.case_ids !== undefined) return cases.filter((c) => overrides.case_ids!.includes(c.id));
  if (overrides.tags !== undefined) {
    const wanted = new Set(overrides.tags);
    return cases.filter((c) => (c.tags ?? []).some((tag) => wanted.has(tag)));
  }
  if (failedIds !== undefined) return cases.filter((c) => failedIds.has(c.id));
  return [...cases];
}

export function planInternalAgent(args: {
  input: BuildEvalPlanInput;
  loaded: LoadedEval;
  dataset: Dataset;
  findings: ValidationFinding[];
  overrides: EvalOverrides;
  failedIds?: Set<string>;
}): BuildEvalPlanResult {
  const { input, loaded, dataset, overrides, failedIds } = args;
  const findings = [...args.findings];
  const fail = (extra: ValidationFinding[]): BuildEvalPlanResult => ({ ok: false, code: "EVAL_INVALID", findings: [...findings, ...extra] });
  if (loaded.file.target.kind !== "internal_agent") return fail([]);
  const profileId = loaded.file.target.profile;
  const profiles = input.internalAgents ?? [];
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return fail([
      evalFinding(
        loaded.relPath,
        "error",
        profiles.length === 0 ? "eval.internal_agent_unavailable" : "eval.internal_agent_unknown",
        profiles.length === 0
          ? "This Host is not showing internal agents, so this eval cannot run"
          : `This Host has no internal agent "${profileId}"`,
      ),
    ]);
  }

  if (overrides.case_ids !== undefined) {
    const known = new Set(dataset.cases.map((c) => c.id));
    const unknown = overrides.case_ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return fail([
        evalFinding(loaded.relPath, "error", "eval.invalid_field", `Override "case_ids" names ${unknown.length} case(s) not in the dataset; first: ${unknown[0]}`),
      ]);
    }
  }

  const conversation = resolveConversation(loaded.file.conversation);
  if (conversation.tools === "real") {
    return fail([
      evalFinding(loaded.relPath, "error", "eval.internal_agent_real_tools", "An internal agent eval cannot use real tools"),
    ]);
  }
  const checks = new Map(checkDatasetAgainstAgent(dataset.cases, { mode: conversation.mode }).map((r) => [r.caseId, r.valid]));
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

  const repeats = loaded.file.defaults?.repeats ?? EVAL_DEFAULT_REPEATS;
  const results = planCases.length * repeats;
  if (planCases.length === 0) {
    return fail([evalFinding(loaded.relPath, "error", "eval.no_valid_cases", "No valid cases are left to run after case selection and skipping")]);
  }
  if (results > EVAL_LIMITS.maxResultsPerRun) {
    return fail([
      evalFinding(loaded.relPath, "error", "eval.too_large_run", `${planCases.length} case(s) x ${repeats} repeat(s) = ${results} results, over the ${EVAL_TOO_LARGE_RUN} limit`),
    ]);
  }
  if (results > EVAL_LARGE_RUN) {
    findings.push(evalFinding(loaded.relPath, "warning", "eval.large_run", `${planCases.length} case(s) x ${repeats} repeat(s) = ${results} results, over ${EVAL_LARGE_RUN}`));
  }

  const defaults = loaded.file.defaults ?? {};
  const passThreshold = defaults.pass_threshold ?? EVAL_DEFAULT_PASS_THRESHOLD;
  const concurrency = defaults.concurrency ?? EVAL_AGENT_DEFAULT_CONCURRENCY;
  const maxCostUsd = defaults.max_cost_usd ?? EVAL_AGENT_DEFAULT_MAX_COST_USD;
  const judge = defaults.judge ?? "";
  const model = defaults.model ?? "";
  const playbookHash = sha256Hex(profile.playbook);
  const definitionHash = sha256Hex(JSON.stringify({ playbook: profile.playbook, tools: profile.tools }));
  const userModel = planCases.some((c) => (c.input as { mode?: string }).mode === "simulated") ? (defaults.user_model ?? null) : null;
  const paths = resolveEvalPaths(loaded.file, loaded.path);
  const projectRoot = input.projectRoot;

  const components = buildComponents({
    stageVersionHash: definitionHash,
    model,
    datasetHash: dataset.contentHash,
    caseIds: runCases.length < validCases.length ? runCases.map((c) => c.id) : null,
    graders: loaded.graders,
    judge,
    repeats,
    passThreshold,
    engine: input.engine,
    agent: {
      revision: 0,
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
    evalDefinition: {
      version: 1,
      id: loaded.id,
      target: { kind: "internal_agent", profile: profileId },
      dataset: posix(projectRoot, paths.datasetPath),
    },
    overrides: snapshotOverrides,
    target: {
      profile_id: profileId,
      title: profile.title,
      playbook_hash: playbookHash,
      tools: profile.tools,
      model,
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
      judge_same_as_stage: false,
      max_cost_usd: maxCostUsd,
      concurrency,
      suite_type: loaded.file.type ?? "capability",
      conversation: {
        mode: conversation.mode,
        max_turns: conversation.maxTurns,
        turn_timeout_ms: conversation.turnTimeoutMs,
        tools: conversation.tools,
        approvals: conversation.approvals,
        read_only_tools: conversation.readOnlyTools,
        real_tools_confirmed: false,
        user_model: userModel ?? "",
        user_model_from_judge: false,
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
    target: { kind: "internal_agent", profileId },
    targetVersionHash: definitionHash,
    stageModel: model,
    task: {},
    cases: planCases,
    graders: loaded.graders,
    repeats,
    passThreshold,
    concurrency,
    maxCostUsd,
    ...(model !== "" ? { modelOverride: model } : {}),
    conversation,
    userModel,
    agent: { definitionHash, definition: { id: profileId, title: profile.title, tools: profile.tools } },
  };
  return { ok: true, plan, snapshot, fingerprint, components, skippedCaseIds, findings };
}
