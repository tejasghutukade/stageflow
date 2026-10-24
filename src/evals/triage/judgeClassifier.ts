import type { SimulatorModel } from "../runner/simulatorModel.js";
import { TRIAGE_BUCKETS, type TriageBucket } from "./constants.js";
import { normalizeBucketProbabilities } from "./jevClassifier.js";
import { failureTypesFor, judgeSystemPrompt, judgeUserPrompt } from "./prompts.js";
import { ClassifierError, type ClassifyInput, type ClassifyOutput, type FailureClassifier } from "./types.js";

const JUDGE_CALL_TIMEOUT_MS = 120_000;

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

/**
 * Judge-model backend: the same one-shot model call the agent simulator uses, with a fixed prompt and a JSON reply.
 * `model` is any `SimulatorModel`; the Host builds it from the agent backend.
 */
export function createJudgeClassifier(options: { model: SimulatorModel; modelId: string }): FailureClassifier {
  return {
    source: "judge",
    model: options.modelId,
    async classify(input: ClassifyInput): Promise<ClassifyOutput> {
      const signal = input.signal ?? AbortSignal.timeout(JUDGE_CALL_TIMEOUT_MS);
      let reply;
      try {
        reply = await options.model.complete({
          system: judgeSystemPrompt(),
          user: judgeUserPrompt({
            targetKind: input.targetKind,
            state: input.state,
            graderIds: input.graderQuestions.map((q) => q.graderId),
          }),
          signal,
        });
      } catch {
        throw new ClassifierError("CLASSIFIER_FAILED", "The judge model call failed");
      }
      const parsed = extractJson(reply.text);
      const bucketRaw = parsed?.bucket;
      if (parsed === null || typeof bucketRaw !== "string" || !(TRIAGE_BUCKETS as readonly string[]).includes(bucketRaw)) {
        throw new ClassifierError("CLASSIFIER_BAD_REPLY", "The judge model did not return a valid bucket");
      }
      const bucket = bucketRaw as TriageBucket;
      const confidence = num(parsed.confidence) ?? 0.5;
      const types = failureTypesFor(input.targetKind) as readonly string[];
      const failureType = typeof parsed.failure_type === "string" && types.includes(parsed.failure_type) ? parsed.failure_type : null;
      const known = new Set(input.graderQuestions.map((q) => q.graderId));
      const alarms = Array.isArray(parsed.grader_false_alarms) ? parsed.grader_false_alarms : [];
      const graderFalseAlarms = alarms.flatMap((entry) => {
        const rec = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
        const p = num(rec.probability);
        return typeof rec.grader_id === "string" && known.has(rec.grader_id) && p !== undefined
          ? [{ graderId: rec.grader_id, probability: p }]
          : [];
      });
      return {
        bucket,
        confidence,
        bucketProbabilities: normalizeBucketProbabilities(undefined, bucket, confidence),
        failureType,
        graderFalseAlarms,
        costUsd: reply.usage?.costUsd ?? 0,
        ...(reply.usage?.model !== undefined ? { answeredModel: reply.usage.model } : {}),
      };
    },
  };
}
