import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENT_ID_PATTERN, isReservedAgentId } from "../agents/agentId.js";
import { canonicalJson, hash6, sha256Hex } from "../evals/canonical.js";
import type {
  EvalBudget,
  EvalConversation,
  EvalDefaults,
  JudgeSettings,
  EvalFile,
  EvalTarget,
  EvalTask,
  FieldCheck,
  FieldOp,
  FinalReplyCheck,
  GraderConfig,
  ResolvedConversation,
  ResolvedGrader,
  RubricExample,
  ToolArgCheck,
} from "../evals/types.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";
import { yamlParsePosition } from "./yamlParsePosition.js";

type UnhashedGrader = ResolvedGrader extends infer G ? (G extends unknown ? Omit<G, "hash"> : never) : never;

export type LoadedEval = {
  path: string;
  relPath: string;
  id: string;
  fileHash: string;
  file: EvalFile;
  graders: ResolvedGrader[];
};

export const EVAL_DEFAULT_REPEATS = 3;
export const EVAL_DEFAULT_PASS_THRESHOLD = 0.8;
export const EVAL_DEFAULT_MAX_COST_USD = 2;
export const EVAL_DEFAULT_CONCURRENCY = 4;
export const EVAL_AGENT_DEFAULT_CONCURRENCY = 2;
export const EVAL_AGENT_DEFAULT_MAX_COST_USD = 1;

export const EVAL_CONVERSATION_DEFAULTS: ResolvedConversation = {
  mode: "script",
  maxTurns: 8,
  turnTimeoutMs: 120_000,
  tools: "read_only",
  approvals: "record_only",
  readOnlyTools: [],
  allowRealTools: false,
};

export function resolveConversation(conversation: EvalConversation | undefined): ResolvedConversation {
  const d = EVAL_CONVERSATION_DEFAULTS;
  return {
    mode: conversation?.mode ?? d.mode,
    maxTurns: conversation?.max_turns ?? d.maxTurns,
    turnTimeoutMs: conversation?.turn_timeout_ms ?? d.turnTimeoutMs,
    tools: conversation?.tools ?? d.tools,
    approvals: conversation?.approvals ?? d.approvals,
    readOnlyTools: [...(conversation?.read_only_tools ?? d.readOnlyTools)],
    allowRealTools: conversation?.allow_real_tools ?? d.allowRealTools,
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GRADER_TYPES = [
  "schema",
  "field",
  "reference",
  "rubric",
  "code",
  "tool_calls",
  "conversation_check",
  "goal_reached",
] as const;
const FIELD_OPS: readonly FieldOp[] = [
  "exists",
  "not_empty",
  "equals",
  "not_equals",
  "contains",
  "matches",
  "gte",
  "lte",
  "between",
  "in",
  "length_gte",
  "length_lte",
];
const FIELD_PATH_PATTERN = /^[^.[\]\s]+(?:\.[^.[\]\s]+|\[(?:\d+|\*)\])*$/;

const TOP_KEYS = [
  "version",
  "id",
  "name",
  "description",
  "type",
  "target",
  "dataset",
  "task",
  "defaults",
  "conversation",
  "graders",
  "budget",
];
const TARGET_KEYS = ["kind", "pipeline", "stage", "file"];
const AGENT_TARGET_KEYS = ["kind", "agent"];
const CONVERSATION_KEYS = [
  "mode",
  "max_turns",
  "turn_timeout_ms",
  "tools",
  "approvals",
  "read_only_tools",
  "allow_real_tools",
];
const READ_ONLY_TOOL_PATTERN = /^[A-Za-z0-9_.*:-]{1,128}$/;
const TASK_KEYS = ["goal", "context", "constraints"];
const DEFAULTS_KEYS = [
  "repeats",
  "judge",
  "judge_settings",
  "pass_threshold",
  "max_cost_usd",
  "concurrency",
  "model",
  "user_model",
];
const BUDGET_KEYS = ["latency_ms", "cost_usd"];
const GRADER_COMMON_KEYS = ["id", "type", "description", "weight", "must_pass"];
const GRADER_TYPE_KEYS: Record<(typeof GRADER_TYPES)[number], string[]> = {
  schema: [],
  field: ["checks"],
  reference: ["mode", "path", "expected", "pass_at"],
  rubric: ["rubric", "scale", "pass_at", "judge", "judge_settings", "examples"],
  code: ["code"],
  tool_calls: ["must_call", "must_not_call", "must_ask_first", "max_calls", "args"],
  conversation_check: ["max_turns", "max_agent_questions_per_turn", "final_reply"],
  goal_reached: ["judge", "judge_settings", "guidance"],
};
const TOOL_ARG_KEYS = ["tool", "path", "op", "value"];
const FINAL_REPLY_KEYS = ["op", "value"];
const CHECK_KEYS = ["path", "op", "value"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evalIssue(code: string, message: string): LoadIssue {
  return { code, message, category: "eval" };
}

export function evalFileStem(filePath: string): string {
  const base = path.basename(filePath);
  const match = /^(.*)\.eval\.ya?ml$/.exec(base);
  if (match) return match[1] ?? base;
  return base.slice(0, base.length - path.extname(base).length);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type EvalPaths = {
  pipelinePath?: string;
  stageFile?: string;
  datasetPath: string;
};

/** Paths in an eval file resolve against the eval file's directory (P6). */
export function resolveEvalPaths(file: EvalFile, evalAbsPath: string): EvalPaths {
  const dir = path.dirname(evalAbsPath);
  const stage = file.target.kind === "stage" ? file.target : undefined;
  return {
    ...(stage?.pipeline !== undefined ? { pipelinePath: path.resolve(dir, stage.pipeline) } : {}),
    ...(stage?.file !== undefined ? { stageFile: path.resolve(dir, stage.file) } : {}),
    datasetPath: path.resolve(dir, file.dataset),
  };
}

class Collector {
  readonly issues: LoadIssue[] = [];

  add(code: string, message: string): void {
    this.issues.push(evalIssue(code, message));
  }

  unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.add("eval.unknown_key", `Unknown key "${key}" in ${where}`);
      }
    }
  }
}

function optionalString(
  c: Collector,
  obj: Record<string, unknown>,
  key: string,
  where: string,
  limits: { min?: number; max?: number } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    c.add("eval.invalid_field", `${where} "${key}" must be a string`);
    return undefined;
  }
  const min = limits.min ?? 0;
  if (value.length < min || (limits.max !== undefined && value.length > limits.max)) {
    const range =
      limits.max !== undefined ? `${min}-${limits.max} characters` : `at least ${min} character(s)`;
    c.add("eval.invalid_field", `${where} "${key}" must be ${range}`);
    return undefined;
  }
  return value;
}

function optionalNumber(
  c: Collector,
  obj: Record<string, unknown>,
  key: string,
  where: string,
  rule: string,
  ok: (n: number) => boolean,
  code = "eval.invalid_field",
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !ok(value)) {
    c.add(code, `${where} "${key}" must be ${rule}`);
    return undefined;
  }
  return value;
}

function isIntegerIn(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

function parseTarget(c: Collector, raw: unknown): EvalTarget | undefined {
  if (raw === undefined) {
    c.add("eval.invalid_field", `Missing required key "target"`);
    return undefined;
  }
  if (!isPlainObject(raw)) {
    c.add("eval.invalid_field", `"target" must be a mapping`);
    return undefined;
  }
  if (raw.kind === undefined) {
    c.add("eval.invalid_field", `target "kind" is required ("stage" or "agent")`);
    return undefined;
  }
  if (raw.kind === "agent") return parseAgentTarget(c, raw);
  if (raw.kind !== "stage") {
    c.add(
      "eval.target_kind_unsupported",
      `target kind ${JSON.stringify(raw.kind)} is not supported (only "stage" and "agent")`,
    );
    return undefined;
  }
  if (raw.agent !== undefined) {
    c.add("eval.target_invalid", `target "agent" is only valid with kind: agent`);
    return undefined;
  }
  c.unknownKeys(raw, TARGET_KEYS, "target");
  const pipeline = raw.pipeline;
  const stage = raw.stage;
  const file = raw.file;
  for (const [key, value] of [
    ["pipeline", pipeline],
    ["stage", stage],
    ["file", file],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      c.add("eval.invalid_field", `target "${key}" must be a non-empty string`);
      return undefined;
    }
  }
  const pipelineForm = pipeline !== undefined || stage !== undefined;
  const fileForm = file !== undefined;
  if (pipelineForm === fileForm || (pipelineForm && (pipeline === undefined || stage === undefined))) {
    c.add(
      "eval.target_invalid",
      "target must be exactly one of: { kind: stage, pipeline, stage } or { kind: stage, file }",
    );
    return undefined;
  }
  return {
    kind: "stage",
    ...(pipeline !== undefined ? { pipeline: pipeline as string } : {}),
    ...(stage !== undefined ? { stage: stage as string } : {}),
    ...(file !== undefined ? { file: file as string } : {}),
  };
}

function parseAgentTarget(c: Collector, raw: Record<string, unknown>): EvalTarget | undefined {
  if (raw.revision !== undefined) {
    c.add("eval.target_invalid", `target "revision" is recorded by the run, not authored`);
    return undefined;
  }
  for (const key of ["pipeline", "stage", "file"]) {
    if (raw[key] !== undefined) {
      c.add("eval.target_invalid", `target "${key}" is only valid with kind: stage`);
      return undefined;
    }
  }
  c.unknownKeys(raw, AGENT_TARGET_KEYS, "target");
  const agent = raw.agent;
  if (typeof agent !== "string" || !AGENT_ID_PATTERN.test(agent)) {
    c.add(
      "eval.target_invalid",
      `target "agent" must be an agent id matching ${AGENT_ID_PATTERN.source}`,
    );
    return undefined;
  }
  if (isReservedAgentId(agent)) {
    c.add("eval.target_invalid", `target agent id "${agent}" is reserved`);
    return undefined;
  }
  return { kind: "agent", agent };
}

function parseTask(c: Collector, raw: unknown): EvalTask | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    c.add("eval.invalid_field", `"task" must be a mapping`);
    return undefined;
  }
  c.unknownKeys(raw, TASK_KEYS, "task");
  const out: EvalTask = {};
  for (const key of TASK_KEYS) {
    const value = optionalString(c, raw, key, "task");
    if (value !== undefined) out[key as keyof EvalTask] = value;
  }
  return out;
}

const JUDGE_SETTINGS_KEYS = ["temperature", "reasoning", "votes"];

/** A mapping of judge call settings, or undefined when absent or invalid (findings added). */
function parseJudgeSettings(c: Collector, raw: unknown, label: string): JudgeSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    c.add("eval.invalid_field", `${label} "judge_settings" must be a mapping`);
    return undefined;
  }
  c.unknownKeys(raw, JUDGE_SETTINGS_KEYS, `${label} judge_settings`);
  const out: JudgeSettings = {};
  let ok = true;
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature === "number" && raw.temperature >= 0 && raw.temperature <= 1) {
      out.temperature = raw.temperature;
    } else {
      c.add("eval.invalid_field", `${label} judge_settings "temperature" must be a number from 0 to 1`);
      ok = false;
    }
  }
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning === "boolean") out.reasoning = raw.reasoning;
    else {
      c.add("eval.invalid_field", `${label} judge_settings "reasoning" must be true or false`);
      ok = false;
    }
  }
  if (raw.votes !== undefined) {
    if (typeof raw.votes === "number" && Number.isInteger(raw.votes) && raw.votes >= 1 && raw.votes <= 5 && raw.votes % 2 === 1) {
      out.votes = raw.votes;
    } else {
      c.add("eval.invalid_field", `${label} judge_settings "votes" must be 1, 3 or 5`);
      ok = false;
    }
  }
  return ok ? out : undefined;
}

/** Grader settings over the eval defaults, key by key; undefined when neither sets anything. */
export function mergeJudgeSettings(
  base: JudgeSettings | undefined,
  over: JudgeSettings | undefined,
): JudgeSettings | undefined {
  const merged = { ...(base ?? {}), ...(over ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function parseDefaults(
  c: Collector,
  raw: unknown,
  kind: EvalTarget["kind"] | undefined,
): EvalDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    c.add("eval.invalid_field", `"defaults" must be a mapping`);
    return undefined;
  }
  c.unknownKeys(raw, DEFAULTS_KEYS, "defaults");
  const out: EvalDefaults = {};
  const repeats = optionalNumber(c, raw, "repeats", "defaults", "an integer from 1 to 10", (n) =>
    isIntegerIn(n, 1, 10),
  );
  if (repeats !== undefined) out.repeats = repeats;
  const judge = optionalString(c, raw, "judge", "defaults", { min: 1 });
  if (judge !== undefined) out.judge = judge;
  const judgeSettings = parseJudgeSettings(c, raw.judge_settings, "defaults");
  if (judgeSettings !== undefined) out.judge_settings = judgeSettings;
  const passThreshold = optionalNumber(
    c,
    raw,
    "pass_threshold",
    "defaults",
    "a number greater than 0 and at most 1",
    (n) => n > 0 && n <= 1,
  );
  if (passThreshold !== undefined) out.pass_threshold = passThreshold;
  const maxCost = optionalNumber(c, raw, "max_cost_usd", "defaults", "a number greater than 0", (n) => n > 0);
  if (maxCost !== undefined) out.max_cost_usd = maxCost;
  const concurrency = optionalNumber(c, raw, "concurrency", "defaults", "an integer from 1 to 8", (n) =>
    isIntegerIn(n, 1, 8),
  );
  if (concurrency !== undefined) out.concurrency = concurrency;
  const model = optionalString(c, raw, "model", "defaults", { min: 1 });
  if (model !== undefined) out.model = model;
  if (raw.user_model !== undefined) {
    if (kind === "stage") {
      c.add("eval.conversation_not_applicable", `defaults "user_model" is only valid with an agent target`);
    } else {
      const userModel = optionalString(c, raw, "user_model", "defaults", { min: 1 });
      if (userModel !== undefined) out.user_model = userModel;
    }
  }
  return out;
}

function parseConversation(
  c: Collector,
  raw: unknown,
  kind: EvalTarget["kind"] | undefined,
): EvalConversation | undefined {
  if (raw === undefined) return undefined;
  if (kind === "stage") {
    c.add("eval.conversation_not_applicable", `"conversation" is only valid with an agent target`);
    return undefined;
  }
  const bad = (key: string, rule: string): void =>
    c.add("eval.conversation_invalid", `conversation "${key}" must be ${rule}`);
  if (!isPlainObject(raw)) {
    c.add("eval.conversation_invalid", `"conversation" must be a mapping`);
    return undefined;
  }
  c.unknownKeys(raw, CONVERSATION_KEYS, "conversation");
  const out: EvalConversation = {};
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    bad(key, `one of: ${allowed.join(", ")}`);
    return undefined;
  };
  const mode = oneOf("mode", ["script", "simulated"] as const);
  if (mode !== undefined) out.mode = mode;
  const maxTurns = optionalNumber(c, raw, "max_turns", "conversation", "an integer from 1 to 30", (n) => isIntegerIn(n, 1, 30), "eval.conversation_invalid");
  if (maxTurns !== undefined) out.max_turns = maxTurns;
  const timeout = optionalNumber(c, raw, "turn_timeout_ms", "conversation", "an integer from 5000 to 600000", (n) => isIntegerIn(n, 5000, 600_000), "eval.conversation_invalid");
  if (timeout !== undefined) out.turn_timeout_ms = timeout;
  const tools = oneOf("tools", ["real", "read_only", "mocked"] as const);
  if (tools !== undefined) out.tools = tools;
  const approvals = oneOf("approvals", ["deny", "auto_approve_read", "record_only"] as const);
  if (approvals !== undefined) out.approvals = approvals;
  if (raw.read_only_tools !== undefined) {
    const list = raw.read_only_tools;
    if (
      Array.isArray(list) &&
      list.length <= 50 &&
      list.every((item) => typeof item === "string" && READ_ONLY_TOOL_PATTERN.test(item))
    ) {
      out.read_only_tools = list as string[];
    } else {
      bad("read_only_tools", "an array of at most 50 tool grant ids");
    }
  }
  if (raw.allow_real_tools !== undefined) {
    if (typeof raw.allow_real_tools !== "boolean") {
      bad("allow_real_tools", "a boolean");
    } else if (raw.allow_real_tools && (tools ?? "read_only") !== "real") {
      c.add("eval.conversation_invalid", `conversation "allow_real_tools" is only valid with tools: real`);
    } else {
      out.allow_real_tools = raw.allow_real_tools;
    }
  }
  return out;
}

function parseBudget(c: Collector, raw: unknown): EvalBudget | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    c.add("eval.invalid_field", `"budget" must be a mapping`);
    return undefined;
  }
  c.unknownKeys(raw, BUDGET_KEYS, "budget");
  const out: EvalBudget = {};
  const latency = optionalNumber(c, raw, "latency_ms", "budget", "a positive number", (n) => n > 0);
  if (latency !== undefined) out.latency_ms = latency;
  const cost = optionalNumber(c, raw, "cost_usd", "budget", "a positive number", (n) => n > 0);
  if (cost !== undefined) out.cost_usd = cost;
  return out;
}

function checkValueProblem(op: FieldOp, value: unknown, present: boolean): string | undefined {
  if (op === "exists" || op === "not_empty") {
    return present ? `op "${op}" takes no value` : undefined;
  }
  if (!present) return `op "${op}" requires a value`;
  switch (op) {
    case "equals":
    case "not_equals":
    case "contains":
      return undefined;
    case "matches": {
      if (typeof value !== "string") return `op "matches" value must be a regular expression string`;
      try {
        new RegExp(value);
      } catch {
        return `op "matches" value is not a valid regular expression`;
      }
      return undefined;
    }
    case "gte":
    case "lte":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `op "${op}" value must be a number`;
    case "between":
      return Array.isArray(value) &&
        value.length === 2 &&
        value.every((v) => typeof v === "number" && Number.isFinite(v)) &&
        (value[0] as number) <= (value[1] as number)
        ? undefined
        : `op "between" value must be [min, max] with min <= max`;
    case "in":
      return Array.isArray(value) ? undefined : `op "in" value must be an array`;
    case "length_gte":
    case "length_lte":
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? undefined
        : `op "${op}" value must be a non-negative integer`;
  }
}

function parseChecks(c: Collector, raw: unknown, where: string): FieldCheck[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    c.add("eval.grader_invalid", `${where} "checks" must be a non-empty array`);
    return undefined;
  }
  const checks: FieldCheck[] = [];
  let ok = true;
  raw.forEach((item, index) => {
    const at = `${where} checks[${index}]`;
    if (!isPlainObject(item)) {
      c.add("eval.grader_invalid", `${at} must be a mapping`);
      ok = false;
      return;
    }
    c.unknownKeys(item, CHECK_KEYS, at);
    if (typeof item.path !== "string" || !FIELD_PATH_PATTERN.test(item.path)) {
      c.add(
        "eval.grader_invalid",
        `${at} "path" must be dot-separated keys with optional [n] or [*] (for example payload.findings[*].line)`,
      );
      ok = false;
      return;
    }
    if (typeof item.op !== "string" || !FIELD_OPS.includes(item.op as FieldOp)) {
      c.add("eval.grader_invalid", `${at} "op" must be one of: ${FIELD_OPS.join(", ")}`);
      ok = false;
      return;
    }
    const op = item.op as FieldOp;
    const problem = checkValueProblem(op, item.value, "value" in item);
    if (problem) {
      c.add("eval.grader_invalid", `${at} ${problem}`);
      ok = false;
      return;
    }
    checks.push({ path: item.path, op, ...("value" in item ? { value: item.value } : {}) });
  });
  return ok ? checks : undefined;
}

function parseExamples(
  c: Collector,
  raw: unknown,
  scale: "pass_fail" | "1_to_5",
  where: string,
): RubricExample[] | undefined {
  if (!Array.isArray(raw) || raw.length > 6) {
    c.add("eval.grader_invalid", `${where} "examples" must be an array of at most 6 items`);
    return undefined;
  }
  const out: RubricExample[] = [];
  let ok = true;
  raw.forEach((item, index) => {
    const at = `${where} examples[${index}]`;
    if (!isPlainObject(item)) {
      c.add("eval.grader_invalid", `${at} must be a mapping`);
      ok = false;
      return;
    }
    c.unknownKeys(item, [scale === "pass_fail" ? "verdict" : "score", "output", "reason"], at);
    if (typeof item.output !== "string") {
      c.add("eval.grader_invalid", `${at} "output" must be a string`);
      ok = false;
      return;
    }
    if (item.reason !== undefined && typeof item.reason !== "string") {
      c.add("eval.grader_invalid", `${at} "reason" must be a string`);
      ok = false;
      return;
    }
    const reason = item.reason as string | undefined;
    if (scale === "pass_fail") {
      if (item.verdict !== "pass" && item.verdict !== "fail") {
        c.add("eval.grader_invalid", `${at} "verdict" must be "pass" or "fail"`);
        ok = false;
        return;
      }
      out.push({ verdict: item.verdict, output: item.output, ...(reason !== undefined ? { reason } : {}) });
      return;
    }
    if (typeof item.score !== "number" || !isIntegerIn(item.score, 1, 5)) {
      c.add("eval.grader_invalid", `${at} "score" must be an integer from 1 to 5`);
      ok = false;
      return;
    }
    out.push({ score: item.score, output: item.output, ...(reason !== undefined ? { reason } : {}) });
  });
  return ok ? out : undefined;
}

function optionalToolList(
  c: Collector,
  raw: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 128)
  ) {
    c.add("eval.grader_invalid", `${where} "${key}" must be an array of at most 50 tool names`);
    return undefined;
  }
  return value as string[];
}

function parseToolArgs(c: Collector, raw: unknown, where: string): ToolArgCheck[] | undefined {
  if (!Array.isArray(raw) || raw.length > 20) {
    c.add("eval.grader_invalid", `${where} "args" must be an array of at most 20 checks`);
    return undefined;
  }
  const out: ToolArgCheck[] = [];
  let ok = true;
  raw.forEach((item, index) => {
    const at = `${where} args[${index}]`;
    if (!isPlainObject(item)) {
      c.add("eval.grader_invalid", `${at} must be a mapping`);
      ok = false;
      return;
    }
    c.unknownKeys(item, TOOL_ARG_KEYS, at);
    if (typeof item.tool !== "string" || item.tool.length < 1 || item.tool.length > 128) {
      c.add("eval.grader_invalid", `${at} "tool" must be a tool name`);
      ok = false;
      return;
    }
    if (typeof item.path !== "string" || !FIELD_PATH_PATTERN.test(item.path)) {
      c.add("eval.grader_invalid", `${at} "path" must be dot-separated keys with optional [n] or [*]`);
      ok = false;
      return;
    }
    if (typeof item.op !== "string" || !FIELD_OPS.includes(item.op as FieldOp)) {
      c.add("eval.grader_invalid", `${at} "op" must be one of: ${FIELD_OPS.join(", ")}`);
      ok = false;
      return;
    }
    const op = item.op as FieldOp;
    const problem = checkValueProblem(op, item.value, "value" in item);
    if (problem) {
      c.add("eval.grader_invalid", `${at} ${problem}`);
      ok = false;
      return;
    }
    out.push({ tool: item.tool, path: item.path, op, ...("value" in item ? { value: item.value } : {}) });
  });
  return ok ? out : undefined;
}

function parseFinalReply(c: Collector, raw: unknown, where: string): FinalReplyCheck[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
    c.add("eval.grader_invalid", `${where} "final_reply" must be an array of 1-10 checks`);
    return undefined;
  }
  const out: FinalReplyCheck[] = [];
  let ok = true;
  raw.forEach((item, index) => {
    const at = `${where} final_reply[${index}]`;
    if (!isPlainObject(item)) {
      c.add("eval.grader_invalid", `${at} must be a mapping`);
      ok = false;
      return;
    }
    c.unknownKeys(item, FINAL_REPLY_KEYS, at);
    if (typeof item.op !== "string" || !FIELD_OPS.includes(item.op as FieldOp)) {
      c.add("eval.grader_invalid", `${at} "op" must be one of: ${FIELD_OPS.join(", ")}`);
      ok = false;
      return;
    }
    const op = item.op as FieldOp;
    const problem = checkValueProblem(op, item.value, "value" in item);
    if (problem) {
      c.add("eval.grader_invalid", `${at} ${problem}`);
      ok = false;
      return;
    }
    out.push({ op, ...("value" in item ? { value: item.value } : {}) });
  });
  return ok ? out : undefined;
}

type ParsedGrader = { config: GraderConfig; resolved: UnhashedGrader };

function parseGrader(
  c: Collector,
  raw: unknown,
  index: number,
  defaultJudge: string | undefined,
  kind: EvalTarget["kind"] | undefined,
  defaultJudgeSettings?: JudgeSettings,
): ParsedGrader | undefined {
  if (!isPlainObject(raw)) {
    c.add("eval.grader_invalid", `graders[${index}] must be a mapping`);
    return undefined;
  }
  const label = typeof raw.id === "string" ? `grader "${raw.id}"` : `graders[${index}]`;
  const before = c.issues.length;

  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
    c.add("eval.invalid_field", `graders[${index}] "id" must match ${ID_PATTERN.source}`);
  }
  const type = raw.type;
  if (type === undefined) {
    c.add("eval.grader_invalid", `${label} "type" is required`);
    return undefined;
  }
  if (type === "command") {
    c.add(
      "eval.grader_type_unsupported",
      `${label} type "command" is not available in release 1 (supported: ${GRADER_TYPES.join(", ")})`,
    );
    return undefined;
  }
  if (typeof type !== "string" || !(GRADER_TYPES as readonly string[]).includes(type)) {
    c.add(
      "eval.grader_type_unsupported",
      `${label} type ${JSON.stringify(type)} is not supported (supported: ${GRADER_TYPES.join(", ")})`,
    );
    return undefined;
  }
  const graderType = type as (typeof GRADER_TYPES)[number];
  const scaleOnGoal = graderType === "goal_reached" && raw.scale !== undefined;
  c.unknownKeys(
    scaleOnGoal ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "scale")) : raw,
    [...GRADER_COMMON_KEYS, ...GRADER_TYPE_KEYS[graderType]],
    label,
  );
  if (scaleOnGoal) {
    c.add("eval.grader_invalid", `${label} "scale" is not accepted: goal_reached is always pass_fail`);
  }

  const description = optionalString(c, raw, "description", label, { max: 200 });
  const weight = optionalNumber(c, raw, "weight", label, "a number greater than 0", (n) => n > 0);
  let mustPass = false;
  if (raw.must_pass !== undefined) {
    if (typeof raw.must_pass === "boolean") mustPass = raw.must_pass;
    else c.add("eval.invalid_field", `${label} "must_pass" must be a boolean`);
  }

  const common = {
    id: String(raw.id),
    ...(description !== undefined ? { description } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(raw.must_pass !== undefined && typeof raw.must_pass === "boolean"
      ? { must_pass: raw.must_pass }
      : {}),
  };
  const resolvedCommon = {
    id: String(raw.id),
    weight: weight ?? 1,
    mustPass,
    ...(description !== undefined ? { description } : {}),
  };

  let result: ParsedGrader | undefined;
  switch (graderType) {
    case "schema":
      result = {
        config: { ...common, type: "schema" },
        resolved: { ...resolvedCommon, type: "schema" },
      };
      break;
    case "field": {
      const checks = parseChecks(c, raw.checks, label);
      if (checks) {
        result = {
          config: { ...common, type: "field", checks },
          resolved: { ...resolvedCommon, type: "field", checks },
        };
      }
      break;
    }
    case "reference": {
      const mode = raw.mode;
      let ok = true;
      if (mode !== "each_mentioned" && mode !== "equals") {
        c.add("eval.grader_invalid", `${label} "mode" must be "each_mentioned" or "equals"`);
        ok = false;
      }
      let pathValue = kind === "agent" ? "final_reply" : "payload";
      if (raw.path !== undefined) {
        if (typeof raw.path === "string" && FIELD_PATH_PATTERN.test(raw.path)) pathValue = raw.path;
        else {
          c.add("eval.grader_invalid", `${label} "path" must be a valid envelope path`);
          ok = false;
        }
      }
      if (typeof raw.expected !== "string" || !FIELD_PATH_PATTERN.test(raw.expected)) {
        c.add("eval.grader_invalid", `${label} "expected" must be a valid path into the case (for example expected.findings)`);
        ok = false;
      }
      const passAt = optionalNumber(
        c,
        raw,
        "pass_at",
        label,
        "a number from 0 to 1",
        (n) => n >= 0 && n <= 1,
        "eval.grader_invalid",
      );
      if (raw.pass_at !== undefined && passAt === undefined) ok = false;
      if (ok) {
        result = {
          config: {
            ...common,
            type: "reference",
            mode: mode as "each_mentioned" | "equals",
            ...(raw.path !== undefined ? { path: pathValue } : {}),
            expected: raw.expected as string,
            ...(passAt !== undefined ? { pass_at: passAt } : {}),
          },
          resolved: {
            ...resolvedCommon,
            type: "reference",
            mode: mode as "each_mentioned" | "equals",
            path: pathValue,
            expected: raw.expected as string,
            passAt: passAt ?? 1,
          },
        };
      }
      break;
    }
    case "rubric": {
      let ok = true;
      if (typeof raw.rubric !== "string" || raw.rubric.length < 1 || raw.rubric.length > 4000) {
        c.add("eval.grader_invalid", `${label} "rubric" must be a string of 1-4000 characters`);
        ok = false;
      }
      let scale: "pass_fail" | "1_to_5" = "pass_fail";
      if (raw.scale !== undefined) {
        if (raw.scale === "pass_fail" || raw.scale === "1_to_5") scale = raw.scale;
        else {
          c.add("eval.grader_invalid", `${label} "scale" must be "pass_fail" or "1_to_5"`);
          ok = false;
        }
      }
      let passAt: number | undefined;
      if (raw.pass_at !== undefined) {
        if (scale === "pass_fail") {
          c.add("eval.grader_invalid", `${label} "pass_at" is only allowed with scale "1_to_5"`);
          ok = false;
        } else if (typeof raw.pass_at === "number" && isIntegerIn(raw.pass_at, 1, 5)) {
          passAt = raw.pass_at;
        } else {
          c.add("eval.grader_invalid", `${label} "pass_at" must be an integer from 1 to 5`);
          ok = false;
        }
      }
      let judge: string | undefined;
      if (raw.judge !== undefined) {
        if (typeof raw.judge === "string" && raw.judge.length > 0) judge = raw.judge;
        else {
          c.add("eval.grader_invalid", `${label} "judge" must be a model id string`);
          ok = false;
        }
      }
      let examples: RubricExample[] | undefined;
      if (raw.examples !== undefined) {
        examples = parseExamples(c, raw.examples, scale, label);
        if (examples === undefined) ok = false;
      }
      const ownSettings = parseJudgeSettings(c, raw.judge_settings, label);
      if (raw.judge_settings !== undefined && ownSettings === undefined) ok = false;
      const judgeSettings = mergeJudgeSettings(defaultJudgeSettings, ownSettings);
      if (ok) {
        result = {
          config: {
            ...common,
            type: "rubric",
            rubric: raw.rubric as string,
            ...(raw.scale !== undefined ? { scale } : {}),
            ...(passAt !== undefined ? { pass_at: passAt } : {}),
            ...(judge !== undefined ? { judge } : {}),
            ...(ownSettings !== undefined ? { judge_settings: ownSettings } : {}),
            ...(examples !== undefined ? { examples } : {}),
          },
          resolved: {
            ...resolvedCommon,
            type: "rubric",
            rubric: raw.rubric as string,
            scale,
            passAt: scale === "1_to_5" ? (passAt ?? 4) : 1,
            judge: judge ?? defaultJudge ?? "",
            ...(judgeSettings !== undefined ? { judgeSettings } : {}),
            examples: examples ?? [],
          },
        };
      }
      break;
    }
    case "code": {
      if (typeof raw.code !== "string" || raw.code.trim() === "") {
        c.add("eval.grader_invalid", `${label} "code" must be a non-empty string`);
      } else {
        result = {
          config: { ...common, type: "code", code: raw.code },
          resolved: { ...resolvedCommon, type: "code", code: raw.code },
        };
      }
      break;
    }
    case "tool_calls": {
      const mustCall = optionalToolList(c, raw, "must_call", label);
      const mustNotCall = optionalToolList(c, raw, "must_not_call", label);
      const mustAskFirst = optionalToolList(c, raw, "must_ask_first", label);
      const maxCalls = optionalNumber(
        c,
        raw,
        "max_calls",
        label,
        "an integer from 0 to 200",
        (n) => isIntegerIn(n, 0, 200),
        "eval.grader_invalid",
      );
      const args = raw.args === undefined ? [] : parseToolArgs(c, raw.args, label);
      if (args !== undefined) {
        result = {
          config: {
            ...common,
            type: "tool_calls",
            ...(mustCall !== undefined ? { must_call: mustCall } : {}),
            ...(mustNotCall !== undefined ? { must_not_call: mustNotCall } : {}),
            ...(mustAskFirst !== undefined ? { must_ask_first: mustAskFirst } : {}),
            ...(maxCalls !== undefined ? { max_calls: maxCalls } : {}),
            ...(raw.args !== undefined ? { args } : {}),
          },
          resolved: {
            ...resolvedCommon,
            type: "tool_calls",
            ...(mustCall !== undefined ? { mustCall } : {}),
            ...(mustNotCall !== undefined ? { mustNotCall } : {}),
            ...(mustAskFirst !== undefined ? { mustAskFirst } : {}),
            ...(maxCalls !== undefined ? { maxCalls } : {}),
            args,
          },
        };
      }
      break;
    }
    case "conversation_check": {
      const maxTurns = optionalNumber(
        c,
        raw,
        "max_turns",
        label,
        "an integer from 1 to 100",
        (n) => isIntegerIn(n, 1, 100),
        "eval.grader_invalid",
      );
      const maxQuestions = optionalNumber(
        c,
        raw,
        "max_agent_questions_per_turn",
        label,
        "an integer from 0 to 10",
        (n) => isIntegerIn(n, 0, 10),
        "eval.grader_invalid",
      );
      const finalReply = raw.final_reply === undefined ? [] : parseFinalReply(c, raw.final_reply, label);
      if (raw.max_turns === undefined && raw.max_agent_questions_per_turn === undefined && raw.final_reply === undefined) {
        c.add(
          "eval.grader_invalid",
          `${label} needs at least one of: max_turns, max_agent_questions_per_turn, final_reply`,
        );
      }
      if (finalReply !== undefined) {
        result = {
          config: {
            ...common,
            type: "conversation_check",
            ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}),
            ...(maxQuestions !== undefined ? { max_agent_questions_per_turn: maxQuestions } : {}),
            ...(raw.final_reply !== undefined ? { final_reply: finalReply } : {}),
          },
          resolved: {
            ...resolvedCommon,
            type: "conversation_check",
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(maxQuestions !== undefined ? { maxAgentQuestionsPerTurn: maxQuestions } : {}),
            finalReply,
          },
        };
      }
      break;
    }
    case "goal_reached": {
      let ok = true;
      let judge: string | undefined;
      if (raw.judge !== undefined) {
        if (typeof raw.judge === "string" && raw.judge.length > 0) judge = raw.judge;
        else {
          c.add("eval.grader_invalid", `${label} "judge" must be a model id string`);
          ok = false;
        }
      }
      let guidance: string | undefined;
      if (raw.guidance !== undefined) {
        if (typeof raw.guidance === "string" && raw.guidance.length <= 2000) guidance = raw.guidance;
        else {
          c.add("eval.grader_invalid", `${label} "guidance" must be a string of at most 2000 characters`);
          ok = false;
        }
      }
      const goalSettings = parseJudgeSettings(c, raw.judge_settings, label);
      if (raw.judge_settings !== undefined && goalSettings === undefined) ok = false;
      const goalMerged = mergeJudgeSettings(defaultJudgeSettings, goalSettings);
      if (ok) {
        result = {
          config: {
            ...common,
            type: "goal_reached",
            ...(judge !== undefined ? { judge } : {}),
            ...(goalSettings !== undefined ? { judge_settings: goalSettings } : {}),
            ...(guidance !== undefined ? { guidance } : {}),
          },
          resolved: {
            ...resolvedCommon,
            type: "goal_reached",
            judge: judge ?? defaultJudge ?? "",
            ...(goalMerged !== undefined ? { judgeSettings: goalMerged } : {}),
            ...(guidance !== undefined ? { guidance } : {}),
          },
        };
      }
      break;
    }
  }
  return c.issues.length > before ? undefined : result;
}

/** Grader hash object: the grader's file keys with defaults filled in; a rubric carries its effective judge. */
function graderHashObject(grader: UnhashedGrader): Record<string, unknown> {
  const base = {
    id: grader.id,
    type: grader.type,
    description: grader.description,
    weight: grader.weight,
    must_pass: grader.mustPass,
  };
  switch (grader.type) {
    case "schema":
      return base;
    case "field":
      return { ...base, checks: grader.checks };
    case "reference":
      return {
        ...base,
        mode: grader.mode,
        path: grader.path,
        expected: grader.expected,
        pass_at: grader.passAt,
      };
    case "rubric":
      return {
        ...base,
        rubric: grader.rubric,
        scale: grader.scale,
        ...(grader.scale === "1_to_5" ? { pass_at: grader.passAt } : {}),
        judge: grader.judge,
        ...(grader.judgeSettings !== undefined ? { judge_settings: grader.judgeSettings } : {}),
        examples: grader.examples,
      };
    case "code":
      return { ...base, code: grader.code };
    case "tool_calls":
      return {
        ...base,
        must_call: grader.mustCall,
        must_not_call: grader.mustNotCall,
        must_ask_first: grader.mustAskFirst,
        max_calls: grader.maxCalls,
        args: grader.args,
      };
    case "conversation_check":
      return {
        ...base,
        max_turns: grader.maxTurns,
        max_agent_questions_per_turn: grader.maxAgentQuestionsPerTurn,
        final_reply: grader.finalReply,
      };
    case "goal_reached":
      return {
        ...base,
        judge: grader.judge,
        ...(grader.judgeSettings !== undefined ? { judge_settings: grader.judgeSettings } : {}),
        guidance: grader.guidance,
      };
  }
}

export function graderHash(grader: UnhashedGrader): string {
  return sha256Hex(canonicalJson(graderHashObject(grader)));
}

export function graderHashShort(grader: Pick<ResolvedGrader, "hash">): string {
  return hash6(grader.hash);
}

export function parseEvalOutcome(
  yamlText: string,
  filePath: string,
  projectRoot: string,
): LoadOutcome<LoadedEval> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return loadFailure([
      {
        ...evalIssue("eval.load_error", err instanceof Error ? err.message : String(err)),
        ...yamlParsePosition(err),
      },
    ]);
  }
  if (!isPlainObject(raw)) {
    return loadFailure([evalIssue("eval.not_object", "Eval file must be a YAML mapping")]);
  }

  const c = new Collector();
  c.unknownKeys(raw, TOP_KEYS, "the eval file");

  if (raw.version !== 1) {
    c.add("eval.invalid_version", `"version" must be 1 (found ${JSON.stringify(raw.version) ?? "none"})`);
  }

  const absPath = path.resolve(filePath);
  const stem = evalFileStem(absPath);
  const id = raw.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    c.add("eval.invalid_id", `"id" must match ${ID_PATTERN.source}`);
  } else if (id !== stem) {
    c.add("eval.id_filename_mismatch", `Eval id "${id}" does not match filename stem "${stem}"`);
  }

  const name = optionalString(c, raw, "name", "eval", { min: 1, max: 80 });
  const description = optionalString(c, raw, "description", "eval", { max: 500 });
  let type: EvalFile["type"];
  if (raw.type !== undefined) {
    if (raw.type === "capability" || raw.type === "regression") type = raw.type;
    else c.add("eval.invalid_field", `"type" must be "capability" or "regression"`);
  }

  const target = parseTarget(c, raw.target);

  let dataset: string | undefined;
  if (raw.dataset === undefined) {
    c.add("eval.invalid_field", `Missing required key "dataset"`);
  } else if (typeof raw.dataset !== "string" || raw.dataset.trim() === "") {
    c.add("eval.invalid_field", `"dataset" must be a non-empty path string`);
  } else {
    dataset = raw.dataset;
  }

  const root = path.resolve(projectRoot);
  const dir = path.dirname(absPath);
  if (dataset !== undefined && !isInside(root, path.resolve(dir, dataset))) {
    c.add("eval.dataset_unresolved", `Dataset path "${dataset}" resolves outside the project root`);
  }
  if (target?.kind === "stage") {
    for (const [key, value] of [
      ["pipeline", target.pipeline],
      ["file", target.file],
    ] as const) {
      if (value !== undefined && !isInside(root, path.resolve(dir, value))) {
        c.add("eval.target_unresolved", `Target ${key} "${value}" resolves outside the project root`);
      }
    }
  }

  let task: EvalTask | undefined;
  if (target?.kind === "agent" && raw.task !== undefined) {
    c.add("eval.task_not_applicable", `"task" is not accepted for an agent target (the scenario goal is input.goal)`);
  } else {
    task = parseTask(c, raw.task);
  }
  const defaults = parseDefaults(c, raw.defaults, target?.kind);
  const conversation = parseConversation(c, raw.conversation, target?.kind);
  const budget = parseBudget(c, raw.budget);

  const parsedGraders: ParsedGrader[] = [];
  if (raw.graders === undefined) {
    c.add("eval.invalid_field", `Missing required key "graders"`);
  } else if (!Array.isArray(raw.graders) || raw.graders.length < 1 || raw.graders.length > 20) {
    c.add("eval.invalid_field", `"graders" must be an array of 1-20 graders`);
  } else {
    const seen = new Set<string>();
    raw.graders.forEach((rawGrader, index) => {
      const parsed = parseGrader(c, rawGrader, index, defaults?.judge, target?.kind, defaults?.judge_settings);
      if (isPlainObject(rawGrader) && typeof rawGrader.id === "string") {
        if (seen.has(rawGrader.id)) {
          c.add("eval.grader_duplicate_id", `Duplicate grader id "${rawGrader.id}"`);
          return;
        }
        seen.add(rawGrader.id);
      }
      if (parsed) parsedGraders.push(parsed);
    });
  }

  if (c.issues.length > 0 || !target || dataset === undefined || typeof id !== "string") {
    return loadFailure(c.issues);
  }

  const file: EvalFile = {
    version: 1,
    id,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(type !== undefined ? { type } : {}),
    target,
    dataset,
    ...(task !== undefined ? { task } : {}),
    ...(defaults !== undefined ? { defaults } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
    graders: parsedGraders.map((g) => g.config),
    ...(budget !== undefined ? { budget } : {}),
  };
  const graders = parsedGraders.map(
    (g) => ({ ...g.resolved, hash: graderHash(g.resolved) }) as ResolvedGrader,
  );
  return loadSuccess({
    path: absPath,
    relPath: path.relative(root, absPath).split(path.sep).join("/"),
    id,
    fileHash: sha256Hex(Buffer.from(yamlText, "utf8")),
    file,
    graders,
  });
}

export async function loadEvalOutcome(
  absPath: string,
  projectRoot: string,
): Promise<LoadOutcome<LoadedEval>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (err) {
    return loadFailure([
      evalIssue("eval.load_error", err instanceof Error ? err.message : String(err)),
    ]);
  }
  const outcome = parseEvalOutcome(bytes.toString("utf8"), absPath, projectRoot);
  if (!outcome.ok) return outcome;
  return loadSuccess({ ...outcome.value, fileHash: sha256Hex(bytes) });
}
