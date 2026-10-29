import type { RunStore } from "../runstore/port.js";
import { replayOutput } from "./calibration.js";
import { calibrationSplitOf } from "./stats.js";
import type { EvalCalibrationRow } from "./storeTypes.js";
import type { CaseOutput, RubricExample } from "./types.js";

export const EXAMPLE_SUGGESTION_LIMIT = 3;
const EXAMPLE_OUTPUT_MAX_CHARS = 1500;

export type SuggestedExample = {
  eval_run_id: string;
  case_id: string;
  repeat_index: number;
  /** What the judge said, so the author can see why this example would help. */
  judge: "pass" | "fail";
  example: RubricExample;
};

export type SuggestStore = Pick<RunStore, "listEvalResults" | "listEvalGraderLabelsForEval">;

function cut(text: string): string {
  return text.length <= EXAMPLE_OUTPUT_MAX_CHARS ? text : `${text.slice(0, EXAMPLE_OUTPUT_MAX_CHARS)}…`;
}

/** The text a judge example shows for one stored output. */
export function exampleOutputText(output: CaseOutput): string {
  if (output.kind === "conversation") return cut(output.transcript ?? output.final_reply);
  const payload = output.payload === undefined ? "" : `\n${JSON.stringify(output.payload)}`;
  return cut(`${output.summary}${payload}`);
}

function exampleFor(scale: "pass_fail" | "1_to_5", label: "pass" | "fail", output: string, reason: string | undefined): RubricExample {
  const base = { output, ...(reason !== undefined && reason !== "" ? { reason } : {}) };
  if (scale === "pass_fail") return { verdict: label, ...base };
  return { score: label === "pass" ? 5 : 1, ...base };
}

/**
 * Up to three few-shot examples built from where the judge disagreed with the author on the dev split (a held-out row
 * is never offered, so the held-out check stays a fair test): one of each kind of
 * disagreement first (judge too lenient, judge too strict), distinct outputs only. The author's label note,
 * when there is one, becomes the example's reason. Nothing is written.
 */
export async function suggestExamples(
  store: SuggestStore,
  input: {
    projectRoot: string;
    evalId: string;
    graderId: string;
    scale: "pass_fail" | "1_to_5";
    calibration: Pick<EvalCalibrationRow, "disagreements">;
    limit?: number;
  },
): Promise<SuggestedExample[]> {
  const limit = input.limit ?? EXAMPLE_SUGGESTION_LIMIT;
  const labels = await store.listEvalGraderLabelsForEval(input.projectRoot, input.evalId, input.graderId);
  const notes = new Map(labels.map((l) => [`${l.evalRunId}#${l.caseId}#${l.repeatIndex}`, l.note]));
  const dev = input.calibration.disagreements.filter((d) => calibrationSplitOf(d.caseId) === "dev");
  const lenient = dev.filter((d) => d.judge === "pass");
  const strict = dev.filter((d) => d.judge === "fail");
  const ordered: typeof lenient = [];
  for (let i = 0; ordered.length < lenient.length + strict.length; i++) {
    if (lenient[i]) ordered.push(lenient[i]!);
    if (strict[i]) ordered.push(strict[i]!);
  }
  const runs = new Map<string, Awaited<ReturnType<SuggestStore["listEvalResults"]>>>();
  const seen = new Set<string>();
  const out: SuggestedExample[] = [];
  for (const d of ordered) {
    if (out.length >= limit) break;
    if (d.evalRunId === undefined) continue;
    let results = runs.get(d.evalRunId);
    if (!results) {
      results = await store.listEvalResults(d.evalRunId);
      runs.set(d.evalRunId, results);
    }
    const result = results.find((r) => r.caseId === d.caseId && r.repeatIndex === d.repeatIndex);
    const output = result ? replayOutput(result.output) : null;
    if (!output) continue;
    const text = exampleOutputText(output);
    if (seen.has(text)) continue;
    seen.add(text);
    const note = notes.get(`${d.evalRunId}#${d.caseId}#${d.repeatIndex}`) ?? undefined;
    out.push({
      eval_run_id: d.evalRunId,
      case_id: d.caseId,
      repeat_index: d.repeatIndex,
      judge: d.judge,
      example: exampleFor(input.scale, d.label, text, note),
    });
  }
  return out;
}
