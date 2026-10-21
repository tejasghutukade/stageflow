import type { EvalDefinition } from "../../../api/evalTypes";

export type GraderConfig = EvalDefinition["graders"][number];
export type GraderType = "schema" | "field" | "reference" | "rubric" | "code";

export const MAX_GRADERS = 20;
export const GRADER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const NOT_CALIBRATED = "Not calibrated";
export const NOT_CALIBRATED_NOTE =
  "Not calibrated. Rubrics are judged by a model and are not checked against your own labels yet.";
export const CODE_HINT =
  "Function body of (output, testCase, context). Return a boolean, a number from 0 to 1, or { pass, score?, reason? }.";

export const GRADER_TYPES: Array<{ type: GraderType; label: string; summary: string; chip: "Check" | "Rubric" }> = [
  { type: "schema", label: "Schema", summary: "Output matches the stage's output schema", chip: "Check" },
  { type: "field", label: "Field check", summary: "Exact checks on fields of the output", chip: "Check" },
  { type: "reference", label: "Reference match", summary: "Compare the output with the case's expected data", chip: "Check" },
  { type: "rubric", label: "Rubric", summary: "A model judges the output against your text", chip: "Rubric" },
  { type: "code", label: "Custom code", summary: "A JavaScript function you write", chip: "Check" },
];

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
  return GRADER_TYPES.find((t) => t.type === type);
}

export function chipFor(type: string): "Check" | "Rubric" {
  return type === "rubric" ? "Rubric" : "Check";
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
  return graders.some((g) => g.type === "rubric" && (typeof g.judge !== "string" || g.judge === ""));
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
  return out;
}
