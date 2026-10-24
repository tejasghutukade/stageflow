import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { mapJudge } from "../evals/judgeProviders.js";
import { checkDatasetAgainstAgent } from "./datasetAgentCheck.js";
import { checkDatasetAgainstStage } from "./datasetStageCheck.js";
import {
  EVAL_DEFAULT_REPEATS,
  resolveConversation,
  resolveEvalPaths,
  type LoadedEval,
} from "./loadEval.js";
import type { LoadIssue } from "./loadOutcome.js";
import {
  resolveAgentTarget,
  resolveAgentTargetFromFile,
  type AgentCatalogPort,
  type ResolvedAgentTarget,
} from "./resolveAgentTarget.js";
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
  datasetInline?: boolean;
  isKnownModel?: (id: string) => Promise<boolean>;
  agents?: AgentCatalogPort;
};

const CONVERSATION_GRADER_TYPES: readonly string[] = ["tool_calls", "conversation_check", "goal_reached"];

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

  const targetKind = file.target.kind;
  for (const grader of loaded.graders) {
    const wrongKind =
      targetKind === "agent"
        ? grader.type === "schema"
        : CONVERSATION_GRADER_TYPES.includes(grader.type);
    if (wrongKind) {
      add(
        "error",
        "eval.grader_not_applicable",
        `Grader "${grader.id}" (${grader.type}) cannot grade ${targetKind === "agent" ? "an agent" : "a stage"} target`,
      );
    }
  }

  if (file.target.kind === "agent") {
    return validateAgentEval(loaded, ctx, findings);
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
  const datasetProblem = ctx.datasetInline
    ? undefined
    : await datasetFileFinding(loaded, paths.datasetPath, ctx.projectRoot);
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

  const mismatches = resolved
    ? checkDatasetAgainstStage(report.cases, resolved.inputSchema).filter((r) => !r.valid)
    : [];
  const skipped = new Set(mismatches.map((m) => m.caseId));
  for (const mismatch of mismatches) {
    findings.push({
      severity: "warning",
      code: "dataset.input_mismatch",
      path: report.relPath,
      message: `case ${mismatch.caseId}: input does not match the stage's io.input.schema: ${mismatch.message}`,
      category: "dataset",
    });
  }
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

function toolGranted(target: ResolvedAgentTarget, name: string): boolean {
  const ids = target.tools.map((tool) => tool.id);
  if (ids.includes(name)) return true;
  if (name.endsWith(".*")) {
    const prefix = name.slice(0, -1);
    return ids.some((id) => id.startsWith(prefix));
  }
  const dot = name.indexOf(".");
  return dot > 0 && ids.includes(`${name.slice(0, dot)}.*`);
}

function isReadClass(tool: ResolvedAgentTarget["tools"][number], listed: readonly string[]): boolean {
  if (tool.risk === "read") return true;
  const dot = tool.id.indexOf(".");
  return listed.some((name) => name === tool.id || (dot > 0 && name === `${tool.id.slice(0, dot)}.*`));
}

function nameList(names: readonly string[]): string {
  return names.slice(0, 5).join(", ") + (names.length > 5 ? ", ..." : "");
}

function hasExpectedTools(c: { expected?: unknown }): boolean {
  const expected = c.expected;
  if (typeof expected !== "object" || expected === null) return false;
  const record = expected as Record<string, unknown>;
  return record.tools !== undefined || record.forbidden_tools !== undefined;
}

async function validateAgentEval(
  loaded: LoadedEval,
  ctx: ValidateEvalContext,
  findings: ValidationFinding[],
): Promise<ValidationFinding[]> {
  const add = (severity: ValidationSeverity, code: string, message: string): void => {
    findings.push(evalFinding(loaded.relPath, severity, code, message));
  };
  const { file } = loaded;
  const conversation = resolveConversation(file.conversation);

  const outcome = ctx.agents
    ? await resolveAgentTarget(file, ctx.projectRoot, ctx.agents)
    : await resolveAgentTargetFromFile(file, ctx.projectRoot);
  let resolved: ResolvedAgentTarget | undefined;
  if (outcome.ok) {
    resolved = outcome.value;
    findings.push(...evalFindingsFromIssues(loaded.relPath, outcome.issues ?? []));
  } else {
    findings.push(...evalFindingsFromIssues(loaded.relPath, outcome.issues));
  }

  if (conversation.tools === "real") {
    if (!conversation.allowRealTools) {
      add(
        "error",
        "eval.real_tools_not_allowed",
        "conversation.tools is real: set allow_real_tools: true to consent to real tools",
      );
    } else {
      add("warning", "eval.tools_real", "Real tools can change files and call services from this machine.");
    }
  }

  const agentModel = file.defaults?.model ?? resolved?.modelResolved;
  const unknownChecked = new Set<string>();
  for (const grader of loaded.graders) {
    if (grader.type !== "rubric" && grader.type !== "goal_reached") continue;
    if (grader.judge === "") {
      add(
        "error",
        "eval.judge_missing",
        `${grader.type === "rubric" ? "Rubric" : "Goal"} grader "${grader.id}" has no judge: set defaults.judge or the grader's judge`,
      );
      continue;
    }
    if (ctx.isKnownModel && !unknownChecked.has(grader.judge)) {
      unknownChecked.add(grader.judge);
      if (!(await ctx.isKnownModel(grader.judge))) {
        add("warning", "eval.judge_unknown_model", `Judge model "${grader.judge}" is not in the model catalog`);
      }
    }
    if (agentModel !== undefined && grader.judge === agentModel) {
      add(
        "warning",
        "eval.judge_same_as_stage",
        `Grader "${grader.id}" uses judge "${grader.judge}", the same model as the agent (self-preference bias)`,
      );
    }
  }

  if (resolved) {
    const grantWarn = (names: readonly string[], where: string): void => {
      const missing = [...new Set(names)].filter((name) => !toolGranted(resolved, name));
      if (missing.length > 0) {
        add("warning", "eval.tool_not_granted", `${where} names tool(s) the agent is not granted: ${nameList(missing)}`);
      }
    };
    for (const grader of loaded.graders) {
      if (grader.type !== "tool_calls") continue;
      grantWarn(
        [
          ...(grader.mustCall ?? []),
          ...(grader.mustNotCall ?? []),
          ...(grader.mustAskFirst ?? []),
          ...grader.args.map((arg) => arg.tool),
        ],
        `Grader "${grader.id}"`,
      );
    }
    grantWarn(conversation.readOnlyTools, "conversation.read_only_tools");
    if (conversation.tools === "read_only") {
      const stubbed = resolved.tools
        .filter((tool) => !isReadClass(tool, conversation.readOnlyTools))
        .map((tool) => tool.id);
      if (stubbed.length > 0) {
        add(
          "warning",
          "eval.tools_unstubbed_list",
          `Tools that are not read-only: ${nameList(stubbed)}. These are stubbed and recorded, not executed`,
        );
      }
    }
  }

  const paths = resolveEvalPaths(file, loaded.path);
  const datasetProblem = ctx.datasetInline
    ? undefined
    : await datasetFileFinding(loaded, paths.datasetPath, ctx.projectRoot);
  const simulatedAnywhere = (inputs: ReadonlyArray<Record<string, unknown>> | undefined): boolean =>
    inputs === undefined
      ? conversation.mode === "simulated"
      : inputs.some((input) => (input.mode ?? conversation.mode) === "simulated");

  const checkSimulator = async (usesSimulator: boolean): Promise<void> => {
    if (!usesSimulator) return;
    const userModel = file.defaults?.user_model ?? file.defaults?.judge;
    if (userModel === undefined) {
      add(
        "error",
        "eval.user_model_missing",
        "Simulated conversations need a user model: set defaults.user_model or defaults.judge",
      );
      return;
    }
    if (mapJudge(userModel) === null) {
      add(
        "error",
        "eval.simulator_unsupported",
        `User model "${userModel}" cannot be used: supported providers are anthropic, openai, openrouter`,
      );
      return;
    }
    if (ctx.isKnownModel && !(await ctx.isKnownModel(userModel))) {
      add("warning", "eval.simulator_unknown_model", `User model "${userModel}" is not in the model catalog`);
    }
    if (agentModel !== undefined && userModel === agentModel) {
      add("warning", "eval.simulator_same_as_agent", `User model "${userModel}" is the same model as the agent`);
    }
  };

  if (datasetProblem) {
    findings.push(datasetProblem);
    await checkSimulator(simulatedAnywhere(undefined));
    return findings;
  }
  const report = ctx.datasetReport;
  if (!report) {
    await checkSimulator(simulatedAnywhere(undefined));
    return findings;
  }

  const datasetErrors = report.findings.filter((f) => f.severity === "error");
  if (datasetErrors.length > 0) {
    add(
      "error",
      "eval.dataset_invalid",
      `Dataset ${report.relPath} has ${datasetErrors.length} error(s); first: ${datasetErrors[0]?.message}`,
    );
  }

  const checks = checkDatasetAgainstAgent(report.cases, { mode: conversation.mode });
  const mismatches = checks.filter((r) => !r.valid);
  const skipped = new Set(mismatches.map((m) => m.caseId));
  for (const mismatch of mismatches) {
    findings.push({
      severity: "warning",
      code: "dataset.input_mismatch",
      path: report.relPath,
      message: `case ${mismatch.caseId}: ${mismatch.message}`,
      category: "dataset",
    });
  }
  for (const note of checks.flatMap((r) => r.notes)) {
    findings.push({
      severity: "warning",
      code: note.code,
      path: report.relPath,
      message: note.message,
      category: "dataset",
    });
  }
  if (mismatches.length > 0) {
    add(
      "warning",
      "eval.cases_skipped",
      `${mismatches.length} case(s) have an invalid scenario and will be skipped when a run starts; first: ${mismatches[0]?.caseId}`,
    );
  }

  const runnable = report.cases.filter((c) => !skipped.has(c.id));
  if (datasetErrors.length === 0 && runnable.length === 0) {
    add("error", "eval.no_valid_cases", `Dataset ${report.relPath} has no valid cases to run`);
  }

  await checkSimulator(simulatedAnywhere(runnable.map((c) => c.input)));

  if (conversation.tools === "mocked" && !runnable.some((c) => c.input.tool_mocks !== undefined)) {
    add("warning", "eval.tools_mocked_no_mocks", "conversation.tools is mocked but no case has tool_mocks");
  }
  if (resolved) {
    const mockNames = runnable.flatMap((c) =>
      typeof c.input.tool_mocks === "object" && c.input.tool_mocks !== null
        ? Object.keys(c.input.tool_mocks)
        : [],
    );
    const missing = [...new Set(mockNames)].filter((name) => !toolGranted(resolved, name));
    if (missing.length > 0) {
      add("warning", "eval.tool_not_granted", `Case tool_mocks name tool(s) the agent is not granted: ${nameList(missing)}`);
    }
  }

  for (const grader of loaded.graders) {
    if (grader.type === "goal_reached") {
      const missingGoal = runnable.filter((c) => {
        const expected = c.expected as Record<string, unknown> | null | undefined;
        const hasGoal = typeof c.input.goal === "string" && c.input.goal !== "";
        const hasOutcome = typeof expected?.outcome === "string" && expected.outcome !== "";
        return !hasGoal && !hasOutcome;
      });
      if (missingGoal.length > 0) {
        add(
          "warning",
          "eval.cases_missing_goal",
          `Grader "${grader.id}": ${missingGoal.length} of ${runnable.length} case(s) have no input.goal or expected.outcome; first: ${missingGoal[0]?.id}`,
        );
      }
    }
    if (
      grader.type === "tool_calls" &&
      grader.mustCall === undefined &&
      grader.mustNotCall === undefined &&
      grader.mustAskFirst === undefined &&
      grader.maxCalls === undefined &&
      grader.args.length === 0
    ) {
      const missingIds = runnable.filter((c) => !hasExpectedTools(c)).map((c) => c.id);
      if (missingIds.length > 0) {
        add(
          "warning",
          "eval.cases_missing_expected",
          `Grader "${grader.id}": ${missingIds.length} of ${runnable.length} case(s) have no expected.tools or expected.forbidden_tools; first: ${missingIds[0]}`,
        );
      }
    }
    if (grader.type === "reference") {
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
