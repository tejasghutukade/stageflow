import type { EvalDefinition } from "../../../api/evalTypes";

export type GraderConfig = EvalDefinition["graders"][number];
export type GraderType = "schema" | "field" | "reference" | "rubric" | "code" | "tool_calls" | "conversation_check" | "goal_reached";
export type GraderTarget = "stage" | "agent";

export const MAX_GRADERS = 20;
export const GRADER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const NOT_CALIBRATED = "Not calibrated";
export const NOT_CALIBRATED_NOTE =
  "Not calibrated. Rubrics are judged by a model and are not checked against your own labels yet.";
export const CODE_HINT =
  "Function body of (output, testCase, context). Return a boolean, a number from 0 to 1, or { pass, score?, reason? }.";

export const GRADER_TYPES: Array<{ type: GraderType; label: string; summary: string; chip: "Check" | "Rubric"; agent?: boolean }> = [
  { type: "schema", label: "Schema", summary: "Output matches the stage's output schema", chip: "Check" },
  { type: "field", label: "Field check", summary: "Exact checks on fields of the output", chip: "Check" },
  { type: "reference", label: "Reference match", summary: "Compare the output with the case's expected data", chip: "Check" },
  { type: "rubric", label: "Rubric", summary: "A model judges the output against your text", chip: "Rubric" },
  { type: "code", label: "Custom code", summary: "A JavaScript function you write", chip: "Check" },
];

export const AGENT_GRADER_TYPES: typeof GRADER_TYPES = [
  { type: "tool_calls", label: "Tool calls", summary: "Which tools the agent called, and with what", chip: "Check", agent: true },
  { type: "conversation_check", label: "Conversation check", summary: "Turn count, questions per turn, final reply", chip: "Check", agent: true },
  { type: "goal_reached", label: "Goal reached", summary: "A model judges whether the goal was achieved", chip: "Rubric", agent: true },
];

/** The Add grader menu: `schema` is stage-only; the conversation types are agent-only. */
export function graderTypesFor(target: GraderTarget): typeof GRADER_TYPES {
  return target === "agent" ? [...GRADER_TYPES.filter((t) => t.type !== "schema"), ...AGENT_GRADER_TYPES] : GRADER_TYPES;
}

export const CONVERSATION_RUBRIC_NOTE = "The judge reads the conversation, capped in length.";
export const GOAL_REACHED_NOTE = "Judged on the whole conversation. Uses each scenario's goal.";
export const TOOL_CALLS_HELPER = "Leave Must call and Must not call empty to use each scenario's expected tools.";

export const FIELD_OPS = [
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
] as const;

const NO_VALUE_OPS = new Set<string>(["exists", "not_empty"]);

export function opNeedsValue(op: string): boolean {
  return !NO_VALUE_OPS.has(op);
}

export function graderTypeInfo(type: string) {
  return GRADER_TYPES.find((t) => t.type === type) ?? AGENT_GRADER_TYPES.find((t) => t.type === type);
}

export function chipFor(type: string): "Check" | "Rubric" {
  return type === "rubric" || type === "goal_reached" ? "Rubric" : "Check";
}

export function nextGraderId(existing: readonly string[]): string {
  let n = existing.length + 1;
  while (existing.includes(`grader-${n}`)) n += 1;
  return `grader-${n}`;
}

export function newGrader(type: GraderType, existingIds: readonly string[]): GraderConfig {
  const id = nextGraderId(existingIds);
  switch (type) {
    case "schema":
      return { id, type, must_pass: true };
    case "field":
      return { id, type, checks: [{ path: "payload", op: "exists" }] };
    case "reference":
      return { id, type, mode: "each_mentioned", path: "payload", expected: "expected" };
    case "rubric":
      return { id, type, rubric: "", scale: "pass_fail" };
    case "code":
      return { id, type, code: "return true;" };
    case "tool_calls":
      return { id, type };
    case "conversation_check":
      return { id, type, max_turns: 8 };
    case "goal_reached":
      return { id, type };
  }
}

export type CommonValues = { description: string; weight: number | null; mustPass: boolean };

export function commonOf(g: GraderConfig): CommonValues {
  return {
    description: typeof g.description === "string" ? g.description : "",
    weight: typeof g.weight === "number" ? g.weight : null,
    mustPass: g.must_pass === true,
  };
}

const COMMON_KEYS = new Set(["id", "type", "description", "weight", "must_pass"]);

/** Rebuilds a grader with the common keys first, in schema order, omitting defaults. */
export function withCommon(g: GraderConfig, values: Partial<CommonValues>): GraderConfig {
  const current = { ...commonOf(g), ...values };
  const rest = Object.fromEntries(Object.entries(g).filter(([k]) => !COMMON_KEYS.has(k)));
  return {
    id: g.id,
    type: g.type,
    ...(current.description.trim() !== "" ? { description: current.description } : {}),
    ...(current.weight !== null && current.weight !== 1 ? { weight: current.weight } : {}),
    ...(current.mustPass ? { must_pass: true } : {}),
    ...rest,
  };
}

export function parseWeight(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Weight must be a number above 0" };
  return { ok: true, value: n };
}

export function validateGraderId(id: string, others: readonly string[]): string | null {
  if (!GRADER_ID_PATTERN.test(id)) return "Use lowercase letters, digits and dashes";
  if (others.includes(id)) return "Another grader already uses this id";
  return null;
}

export function weightLabel(g: GraderConfig): string | null {
  return typeof g.weight === "number" && g.weight !== 1 ? `×${g.weight}` : null;
}

/** Sum of weights of graders that count toward the weighted mean (must-pass graders are excluded). */
export function scoredWeight(graders: readonly GraderConfig[]): number {
  return graders.reduce((sum, g) => (g.must_pass === true ? sum : sum + (typeof g.weight === "number" ? g.weight : 1)), 0);
}

export function describeGrader(g: GraderConfig, outputSchemaName?: string): string {
  if (typeof g.description === "string" && g.description !== "") return g.description;
  switch (g.type) {
    case "schema":
      return `Output matches ${outputSchemaName ?? "the stage's output schema"}`;
    case "field": {
      const n = checksOf(g).length;
      return `${n} ${n === 1 ? "check" : "checks"} on the output`;
    }
    case "reference":
      return `Output compared with ${typeof g.expected === "string" ? g.expected : "expected"}`;
    case "rubric": {
      const text = typeof g.rubric === "string" ? (g.rubric.trim().split("\n")[0] ?? "") : "";
      return text === "" ? "No rubric text yet" : text.length > 90 ? `${text.slice(0, 89)}…` : text;
    }
    case "code":
      return "Custom function";
    case "tool_calls":
      return describeToolCalls(g);
    case "conversation_check":
      return describeConversationCheck(g);
    case "goal_reached":
      return typeof g.guidance === "string" && g.guidance.trim() !== "" ? g.guidance.trim().split("\n")[0]! : GOAL_REACHED_NOTE;
    default:
      return "";
  }
}

export function footerText(graders: readonly GraderConfig[], threshold: number): string {
  const n = graders.length;
  const pct = `${Math.round(threshold * 1000) / 10}%`;
  return `${n} ${n === 1 ? "grader" : "graders"} · scored graders add up to a weight of ${scoredWeight(graders)} · a run passes at ${pct} or higher.`;
}

export function hasRubricWithoutJudge(graders: readonly GraderConfig[]): boolean {
  return graders.some((g) => (g.type === "rubric" || g.type === "goal_reached") && (typeof g.judge !== "string" || g.judge === ""));
}

export type FieldCheck = { path: string; op: string; value?: unknown };
export type FieldCheckRow = { path: string; op: string; valueText: string };

export function checkToRow(c: FieldCheck): FieldCheckRow {
  const v = c.value;
  return { path: c.path, op: c.op, valueText: v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v) };
}

export function checksOf(g: GraderConfig): FieldCheck[] {
  return Array.isArray(g.checks) ? (g.checks as FieldCheck[]) : [];
}

type Json = { ok: true; value: unknown } | { ok: false };

function tryJson(text: string): Json {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function rowToCheck(row: FieldCheckRow): { ok: true; check: FieldCheck } | { ok: false; error: string } {
  const path = row.path.trim();
  if (path === "") return { ok: false, error: "Path is required" };
  if (!opNeedsValue(row.op)) return { ok: true, check: { path, op: row.op } };
  const text = row.valueText;
  switch (row.op) {
    case "matches":
      if (text === "") return { ok: false, error: "Value is required" };
      try {
        new RegExp(text);
      } catch {
        return { ok: false, error: "Not a valid regular expression" };
      }
      return { ok: true, check: { path, op: row.op, value: text } };
    case "gte":
    case "lte": {
      const n = Number(text);
      return text.trim() !== "" && Number.isFinite(n)
        ? { ok: true, check: { path, op: row.op, value: n } }
        : { ok: false, error: "Value must be a number" };
    }
    case "length_gte":
    case "length_lte": {
      const n = Number(text);
      return text.trim() !== "" && Number.isInteger(n) && n >= 0
        ? { ok: true, check: { path, op: row.op, value: n } }
        : { ok: false, error: "Value must be a whole number" };
    }
    case "between": {
      const parsed = tryJson(text);
      const v = parsed.ok ? parsed.value : null;
      if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number") && v[0] <= v[1]) {
        return { ok: true, check: { path, op: row.op, value: v } };
      }
      return { ok: false, error: "Use [min, max]" };
    }
    case "in": {
      const parsed = tryJson(text);
      return parsed.ok && Array.isArray(parsed.value)
        ? { ok: true, check: { path, op: row.op, value: parsed.value } }
        : { ok: false, error: "Use a JSON array" };
    }
    case "equals":
    case "not_equals":
    case "contains": {
      if (text === "") return { ok: false, error: "Value is required" };
      const parsed = tryJson(text);
      return { ok: true, check: { path, op: row.op, value: parsed.ok ? parsed.value : text } };
    }
    default:
      return { ok: false, error: "Unknown operator" };
  }
}

export function addCheck(g: GraderConfig): GraderConfig {
  return { ...g, checks: [...checksOf(g), { path: "payload", op: "exists" }] };
}

export function removeCheck(g: GraderConfig, index: number): GraderConfig {
  return { ...g, checks: checksOf(g).filter((_, i) => i !== index) };
}

export function updateCheck(g: GraderConfig, index: number, check: FieldCheck): GraderConfig {
  return { ...g, checks: checksOf(g).map((c, i) => (i === index ? check : c)) };
}

export type Scale = "pass_fail" | "1_to_5";
export type RubricExample = { verdict?: "pass" | "fail"; score?: number; output: string; reason?: string };

export function scaleOf(g: GraderConfig): Scale {
  return g.scale === "1_to_5" ? "1_to_5" : "pass_fail";
}

export function showPassAt(g: GraderConfig): boolean {
  return g.type === "rubric" && scaleOf(g) === "1_to_5";
}

export function examplesOf(g: GraderConfig): RubricExample[] {
  return Array.isArray(g.examples) ? (g.examples as RubricExample[]) : [];
}

function convertExample(e: RubricExample, to: Scale, passAt: number): RubricExample {
  const { verdict, score, ...rest } = e;
  if (to === "1_to_5") return { ...rest, score: score ?? (verdict === "pass" ? 5 : 1) };
  return { ...rest, verdict: verdict ?? ((score ?? 0) >= passAt ? "pass" : "fail") };
}

/** Keeps `pass_at` only for 1_to_5 and converts examples to the new shape. */
export function setScale(g: GraderConfig, scale: Scale): GraderConfig {
  const passAt = typeof g.pass_at === "number" ? g.pass_at : 4;
  const { pass_at: _p, examples: _e, scale: _s, ...rest } = g;
  void _p;
  void _e;
  void _s;
  const examples = examplesOf(g).map((e) => convertExample(e, scale, passAt));
  return {
    ...rest,
    scale,
    ...(scale === "1_to_5" ? { pass_at: passAt } : {}),
    ...(examples.length > 0 ? { examples } : {}),
  } as GraderConfig;
}

export function setPassAt(g: GraderConfig, passAt: number): GraderConfig {
  return scaleOf(g) === "1_to_5" ? { ...g, pass_at: Math.min(5, Math.max(1, Math.round(passAt))) } : g;
}

export const MAX_EXAMPLES = 6;

export function addExample(g: GraderConfig, verdict: "pass" | "fail" = "pass"): GraderConfig {
  const list = examplesOf(g);
  if (list.length >= MAX_EXAMPLES) return g;
  const example: RubricExample =
    scaleOf(g) === "1_to_5" ? { score: verdict === "pass" ? 5 : 1, output: "" } : { verdict, output: "" };
  return { ...g, examples: [...list, example] };
}

export function updateExample(g: GraderConfig, index: number, patch: Partial<RubricExample>): GraderConfig {
  const next = examplesOf(g).map((e, i) => {
    if (i !== index) return e;
    const merged = { ...e, ...patch };
    if (merged.reason === "") delete merged.reason;
    return merged;
  });
  return { ...g, examples: next };
}

export function removeExample(g: GraderConfig, index: number): GraderConfig {
  const next = examplesOf(g).filter((_, i) => i !== index);
  const { examples: _e, ...rest } = g;
  void _e;
  return (next.length > 0 ? { ...rest, examples: next } : rest) as GraderConfig;
}

export function setJudge(g: GraderConfig, judge: string): GraderConfig {
  const { judge: _j, ...rest } = g;
  void _j;
  return (judge === "" ? rest : { ...rest, judge }) as GraderConfig;
}

export function graderProblems(g: GraderConfig): string[] {
  const out: string[] = [];
  if (g.type === "rubric" && (typeof g.rubric !== "string" || g.rubric.trim() === "")) {
    out.push("Describe what the judge looks for");
  }
  if (g.type === "rubric" && typeof g.rubric === "string" && g.rubric.length > 4000) {
    out.push("Rubric is limited to 4,000 characters");
  }
  if (g.type === "code" && (typeof g.code !== "string" || g.code.trim() === "")) out.push("Write the function body");
  if (g.type === "field" && checksOf(g).length === 0) out.push("Add at least one check");
  if (g.type === "reference" && (typeof g.expected !== "string" || g.expected.trim() === "")) {
    out.push("Expected path is required");
  }
  if (g.type === "tool_calls") {
    const calls = g.max_calls;
    if (calls !== undefined && !(Number.isInteger(calls) && (calls as number) >= 0 && (calls as number) <= MAX_CALLS_LIMIT)) {
      out.push(`Max calls must be a whole number from 0 to ${MAX_CALLS_LIMIT}`);
    }
    if (argsOf(g).length > MAX_ARGS_ROWS) out.push(`At most ${MAX_ARGS_ROWS} argument checks`);
  }
  if (g.type === "conversation_check") {
    const hasKey = g.max_turns !== undefined || g.max_agent_questions_per_turn !== undefined || finalReplyOf(g).length > 0;
    if (!hasKey) out.push("Set at least one check");
    const turns = g.max_turns;
    if (turns !== undefined && !(Number.isInteger(turns) && (turns as number) >= 1 && (turns as number) <= 100)) out.push("Max turns must be a whole number from 1 to 100");
    const questions = g.max_agent_questions_per_turn;
    if (questions !== undefined && !(Number.isInteger(questions) && (questions as number) >= 0 && (questions as number) <= 10)) {
      out.push("Max questions per agent turn must be a whole number from 0 to 10");
    }
    if (finalReplyOf(g).length > MAX_FINAL_REPLY_ROWS) out.push(`At most ${MAX_FINAL_REPLY_ROWS} final reply checks`);
  }
  if (g.type === "goal_reached" && typeof g.guidance === "string" && g.guidance.length > GUIDANCE_MAX) {
    out.push(`Guidance is limited to ${GUIDANCE_MAX.toLocaleString("en-US")} characters`);
  }
  return out;
}

// ---- agent graders ----------------------------------------------------------------------------

export const MAX_CALLS_LIMIT = 200;
export const MAX_ARGS_ROWS = 20;
export const MAX_FINAL_REPLY_ROWS = 10;
export const GUIDANCE_MAX = 2000;

export type ToolListKey = "must_call" | "must_not_call" | "must_ask_first";

export function stringList(g: GraderConfig, key: ToolListKey): string[] {
  const value = g[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** An empty list drops the key: absent means "use each scenario's expected tools" for must_call and must_not_call. */
export function setStringList(g: GraderConfig, key: ToolListKey, list: readonly string[]): GraderConfig {
  const { [key]: _drop, ...rest } = g;
  void _drop;
  return (list.length === 0 ? rest : { ...rest, [key]: [...list] }) as GraderConfig;
}

export function setOptionalInt(
  g: GraderConfig,
  key: "max_calls" | "max_turns" | "max_agent_questions_per_turn",
  text: string,
  range: { min: number; max: number },
): { ok: true; grader: GraderConfig } | { ok: false; error: string } {
  const { [key]: _drop, ...rest } = g;
  void _drop;
  const t = text.trim();
  if (t === "") return { ok: true, grader: rest as GraderConfig };
  const n = Number(t);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    return { ok: false, error: `Enter a whole number from ${range.min} to ${range.max}` };
  }
  return { ok: true, grader: { ...rest, [key]: n } as GraderConfig };
}

export type ToolArg = { tool: string; path: string; op: string; value?: unknown };
export type ToolArgRow = { tool: string; path: string; op: string; valueText: string };

export function argsOf(g: GraderConfig): ToolArg[] {
  return Array.isArray(g.args) ? (g.args as ToolArg[]) : [];
}

export function argToRow(a: ToolArg): ToolArgRow {
  return { tool: a.tool, ...checkToRow({ path: a.path, op: a.op, ...(a.value !== undefined ? { value: a.value } : {}) }) };
}

export function rowToArg(row: ToolArgRow): { ok: true; arg: ToolArg } | { ok: false; error: string } {
  if (row.tool.trim() === "") return { ok: false, error: "Tool is required" };
  const parsed = rowToCheck({ path: row.path, op: row.op, valueText: row.valueText });
  if (!parsed.ok) return parsed;
  return { ok: true, arg: { tool: row.tool.trim(), ...parsed.check } };
}

export function setArgs(g: GraderConfig, args: readonly ToolArg[]): GraderConfig {
  const { args: _a, ...rest } = g;
  void _a;
  return (args.length === 0 ? rest : { ...rest, args: [...args] }) as GraderConfig;
}

export type FinalReplyCheck = { op: string; value?: unknown };
export type FinalReplyRow = { op: string; valueText: string };

export function finalReplyOf(g: GraderConfig): FinalReplyCheck[] {
  return Array.isArray(g.final_reply) ? (g.final_reply as FinalReplyCheck[]) : [];
}

export function finalReplyToRow(c: FinalReplyCheck): FinalReplyRow {
  const row = checkToRow({ path: "final_reply", op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) });
  return { op: row.op, valueText: row.valueText };
}

export function rowToFinalReply(row: FinalReplyRow): { ok: true; check: FinalReplyCheck } | { ok: false; error: string } {
  const parsed = rowToCheck({ path: "final_reply", op: row.op, valueText: row.valueText });
  if (!parsed.ok) return parsed;
  const { path: _p, ...rest } = parsed.check;
  void _p;
  return { ok: true, check: rest };
}

export function setFinalReply(g: GraderConfig, checks: readonly FinalReplyCheck[]): GraderConfig {
  const { final_reply: _f, ...rest } = g;
  void _f;
  return (checks.length === 0 ? rest : { ...rest, final_reply: [...checks] }) as GraderConfig;
}

function toolGranted(name: string, toolIds: readonly string[]): boolean {
  if (name.endsWith(".*")) {
    const prefix = name.slice(0, -1);
    return toolIds.some((id) => id.startsWith(prefix));
  }
  return toolIds.includes(name);
}

/** Tool names a `tool_calls` grader mentions that the agent is not granted (`eval.tool_not_granted`). */
export function ungrantedToolNames(g: GraderConfig, toolIds: readonly string[]): string[] {
  if (g.type !== "tool_calls") return [];
  const names = [
    ...stringList(g, "must_call"),
    ...stringList(g, "must_not_call"),
    ...stringList(g, "must_ask_first"),
    ...argsOf(g).map((a) => a.tool),
  ];
  return [...new Set(names)].filter((n) => !toolGranted(n, toolIds));
}

function describeToolCalls(g: GraderConfig): string {
  const parts: string[] = [];
  const must = stringList(g, "must_call");
  const not = stringList(g, "must_not_call");
  const ask = stringList(g, "must_ask_first");
  if (must.length > 0) parts.push(`must call ${must.join(", ")}`);
  if (not.length > 0) parts.push(`must not call ${not.join(", ")}`);
  if (ask.length > 0) parts.push(`must ask first ${ask.join(", ")}`);
  if (typeof g.max_calls === "number") parts.push(`at most ${g.max_calls} calls`);
  if (argsOf(g).length > 0) parts.push(`${argsOf(g).length} argument ${argsOf(g).length === 1 ? "check" : "checks"}`);
  const text = parts.join(" · ");
  if (text === "") return "Uses each scenario's expected tools";
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

function describeConversationCheck(g: GraderConfig): string {
  const parts: string[] = [];
  if (typeof g.max_turns === "number") parts.push(`at most ${g.max_turns} turns`);
  if (typeof g.max_agent_questions_per_turn === "number") {
    parts.push(`at most ${g.max_agent_questions_per_turn} ${g.max_agent_questions_per_turn === 1 ? "question" : "questions"} per turn`);
  }
  const reply = finalReplyOf(g).length;
  if (reply > 0) parts.push(`${reply} final reply ${reply === 1 ? "check" : "checks"}`);
  return parts.length === 0 ? "No checks yet" : parts.join(" · ");
}
