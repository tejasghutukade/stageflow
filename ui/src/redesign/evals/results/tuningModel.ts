import type { EvalCalibration, EvalDefinition, EvalExampleSuggestion } from "../../../api/evalTypes";

export const MAX_RUBRIC_EXAMPLES = 6;

type Grader = EvalDefinition["graders"][number];

function mapGrader(definition: EvalDefinition, graderId: string, change: (g: Grader) => Grader | null): EvalDefinition | null {
  let changed = false;
  const graders = definition.graders.map((g) => {
    if (g.id !== graderId || g.type !== "rubric") return g;
    const next = change(g);
    if (next === null) return g;
    changed = true;
    return next;
  });
  return changed ? { ...definition, graders } : null;
}

/** The definition with one suggested example added to the rubric; null when the rubric is missing or full. */
export function withExample(
  definition: EvalDefinition,
  graderId: string,
  example: EvalExampleSuggestion["example"],
): EvalDefinition | null {
  return mapGrader(definition, graderId, (g) => {
    const list = Array.isArray(g.examples) ? (g.examples as unknown[]) : [];
    if (list.length >= MAX_RUBRIC_EXAMPLES) return null;
    return { ...g, examples: [...list, example] };
  });
}

export function withRubric(definition: EvalDefinition, graderId: string, rubric: string): EvalDefinition | null {
  return mapGrader(definition, graderId, (g) => (g.rubric === rubric ? null : { ...g, rubric }));
}

export function rubricOf(definition: EvalDefinition | null, graderId: string): string {
  const g = definition?.graders.find((x) => x.id === graderId);
  return g && typeof g.rubric === "string" ? g.rubric : "";
}

export function exampleCount(definition: EvalDefinition | null, graderId: string): number {
  const g = definition?.graders.find((x) => x.id === graderId);
  return g && Array.isArray(g.examples) ? g.examples.length : 0;
}

function kappaText(c: EvalCalibration): string {
  const k = c.stats.cohen_kappa;
  return k === null || !Number.isFinite(k) ? "n/a" : k.toFixed(2);
}

/** "Candidate on dev: kappa 0.40 to 0.62 (+0.22)", using only numbers the API computed. */
export function compareLine(before: EvalCalibration | null, after: EvalCalibration): string {
  const where = after.split === "all" ? "all labels" : after.split === "dev" ? "dev labels" : "held-out labels";
  const head = `${after.candidate ? "Candidate" : "Saved rubric"} on ${where}: kappa ${kappaText(after)}`;
  if (before === null || before.split !== after.split) return head;
  const a = before.stats.cohen_kappa;
  const b = after.stats.cohen_kappa;
  if (a === null || b === null) return `${head} (was ${kappaText(before)})`;
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "±";
  return `${head} (was ${kappaText(before)}, ${sign}${Math.abs(d).toFixed(2)})`;
}

export function exampleLabel(s: EvalExampleSuggestion): string {
  const human = s.example.verdict ?? (typeof s.example.score === "number" && s.example.score >= 4 ? "pass" : "fail");
  return `${s.case_id}#${s.repeat_index}: you ${human}, judge ${s.judge}`;
}
