import { createHash } from "node:crypto";
import type { RunStore } from "../runstore/port.js";
import { calibrationSplitOf } from "./stats.js";
import type { EvalCalibrationSplit, EvalGraderLabelRow, EvalResultWithGrades } from "./storeTypes.js";
import { renderTranscript } from "./graders/transcript.js";
import type { CaseOutput, ConversationOutput } from "./types.js";

export type CalibrationSampleSource = {
  caseId: string;
  /** Position within the case's samples; the replay repeat index. */
  repeatIndex: number;
  label: "pass" | "fail";
  output: CaseOutput;
  originalRunId: string;
  originalRepeatIndex: number;
};

export type CalibrationStore = Pick<RunStore, "listEvalGraderLabelsForEval" | "listEvalResults">;

function outputKey(caseId: string, output: unknown): string {
  return createHash("sha256")
    .update(caseId)
    .update("\u0000")
    .update(JSON.stringify(output ?? null))
    .digest("hex");
}

/** Rebuilds the in-memory case output from the stored result JSON. */
export function replayOutput(stored: unknown): CaseOutput | null {
  if (stored === null || typeof stored !== "object") return null;
  const o = stored as Record<string, unknown>;
  if (o.kind === "conversation") {
    const out = { ...(o as unknown as ConversationOutput) };
    out.transcript = renderTranscript(out);
    return out;
  }
  if (typeof o.status !== "string" || typeof o.summary !== "string") return null;
  return {
    kind: "envelope",
    status: o.status === "failure" ? "failure" : "success",
    summary: o.summary,
    ...(o.payload !== undefined && typeof o.payload === "object" ? { payload: o.payload as Record<string, unknown> } : {}),
    artifacts: Array.isArray(o.artifacts) ? (o.artifacts as string[]) : [],
  };
}

/**
 * The labeled samples for one grader across every run of the eval: the newest label per identical
 * (case, output), grouped per case with a fresh repeat index so the engine can replay them.
 */
export async function collectCalibrationSamples(
  store: CalibrationStore,
  projectRoot: string,
  evalId: string,
  graderId: string,
  split: EvalCalibrationSplit,
): Promise<CalibrationSampleSource[]> {
  const labels = await store.listEvalGraderLabelsForEval(projectRoot, evalId, graderId);
  const resultsByRun = new Map<string, Map<string, EvalResultWithGrades>>();
  const seen = new Set<string>();
  const perCase = new Map<string, number>();
  const out: CalibrationSampleSource[] = [];
  for (const label of labels) {
    if (split !== "all" && calibrationSplitOf(label.caseId, label.repeatIndex) !== split) continue;
    let results = resultsByRun.get(label.evalRunId);
    if (!results) {
      results = new Map((await store.listEvalResults(label.evalRunId)).map((r) => [`${r.caseId}#${r.repeatIndex}`, r]));
      resultsByRun.set(label.evalRunId, results);
    }
    const result = results.get(`${label.caseId}#${label.repeatIndex}`);
    const output = result ? replayOutput(result.output) : null;
    if (!output) continue;
    const key = outputKey(label.caseId, result?.output);
    if (seen.has(key)) continue;
    seen.add(key);
    const repeatIndex = perCase.get(label.caseId) ?? 0;
    perCase.set(label.caseId, repeatIndex + 1);
    out.push({
      caseId: label.caseId,
      repeatIndex,
      label: label.label,
      output,
      originalRunId: label.evalRunId,
      originalRepeatIndex: label.repeatIndex,
    });
  }
  return out;
}

export type { EvalGraderLabelRow };
