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

/** How many more examples this rubric can take. */
export function exampleSlots(definition: EvalDefinition | null, graderId: string): number {
  return Math.max(0, MAX_RUBRIC_EXAMPLES - exampleCount(definition, graderId));
}

/** The definition with several examples added at once (as many as fit); null when none fit or the rubric is missing. */
export function withExamples(
  definition: EvalDefinition,
  graderId: string,
  examples: Array<EvalExampleSuggestion["example"]>,
): EvalDefinition | null {
  return mapGrader(definition, graderId, (g) => {
    const list = Array.isArray(g.examples) ? (g.examples as unknown[]) : [];
    const room = MAX_RUBRIC_EXAMPLES - list.length;
    if (room <= 0 || examples.length === 0) return null;
    return { ...g, examples: [...list, ...examples.slice(0, room)] };
  });
}

/** The same example with the author's own wording for why. An empty reason drops it. */
export function withReason(example: EvalExampleSuggestion["example"], reason: string): EvalExampleSuggestion["example"] {
  const { reason: _old, ...rest } = example;
  const text = reason.trim();
  return text === "" ? rest : { ...rest, reason: text };
}

/** What went wrong with one of the judge's answers, in words. */
export function exampleKind(s: EvalExampleSuggestion): { title: string; hint: string } {
  const human = s.example.verdict ?? (typeof s.example.score === "number" && s.example.score >= 4 ? "pass" : "fail");
  const youSaid = human === "pass" ? "Pass" : "Fail";
  const judgeSaid = s.judge === "pass" ? "Pass" : "Fail";
  return {
    title: `You said ${youSaid}, the judge said ${judgeSaid}`,
    hint: s.judge === "pass" ? "The judge was too lenient here." : "The judge was too strict here.",
  };
}

export type SplitResult = { saved: EvalCalibration; candidate: EvalCalibration };

export type WordingVerdict = { tone: "ok" | "needs" | "fail" | "muted"; text: string };

const CLEAR_GAIN = 0.05;

function kappaDelta(r: SplitResult): number | null {
  const a = r.saved.stats.cohen_kappa;
  const b = r.candidate.stats.cohen_kappa;
  return a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) ? null : b - a;
}

/** "0.70 to 0.89 (+0.19)" for one split, or a plain note when a number is missing. */
export function changeText(r: SplitResult): string {
  const delta = kappaDelta(r);
  const before = kappaText(r.saved);
  const after = kappaText(r.candidate);
  if (delta === null) return `${before} to ${after}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  return `${before} to ${after} (${sign}${Math.abs(delta).toFixed(2)})`;
}

/**
 * Whether to trust a new wording. Tuning rows are the ones you wrote it against, so only the fair-test rows
 * count as proof: a gain on the tuning rows that vanishes there means the wording fits those cases only.
 */
export function wordingVerdict(dev: SplitResult | null, heldOut: SplitResult | null): WordingVerdict {
  const devDelta = dev ? kappaDelta(dev) : null;
  if (!dev || devDelta === null) return { tone: "muted", text: "Test the wording on your tuning rows first." };
  if (devDelta < CLEAR_GAIN) {
    return { tone: "needs", text: "No clear gain on the tuning rows. This wording is probably not better." };
  }
  if (!heldOut) {
    return { tone: "needs", text: "Better on the tuning rows. Confirm it on the fair-test rows before you save it." };
  }
  const heldDelta = kappaDelta(heldOut);
  if (heldDelta !== null && heldDelta < -CLEAR_GAIN) {
    return { tone: "fail", text: "Worse on the fair-test rows. It likely fits only the cases you tuned on. Do not save it." };
  }
  const few = heldOut.candidate.stats.warnings.includes("low_n");
  return {
    tone: "ok",
    text: few
      ? `Better on the tuning rows and no worse on the fair-test rows. Only ${heldOut.candidate.stats.n} fair-test labels, so treat it as a good sign, not proof.`
      : "Better on the tuning rows and no worse on the fair-test rows. Safe to save.",
  };
}
