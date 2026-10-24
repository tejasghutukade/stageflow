import {
  JEV_BACKOFF_BASE_MS,
  JEV_BASE_URL,
  JEV_MAX_RETRIES,
  JEV_MODEL_ID,
  JEV_PRICE_INPUT_PER_MILLION_USD,
  TRIAGE_BUCKETS,
  type TriageBucket,
} from "./constants.js";
import {
  BUCKET_QUESTION,
  bucketCriteriaMap,
  FAILURE_TYPE_QUESTION,
  failureTypeCriteriaMap,
  failureTypesFor,
  falseAlarmQuestion,
} from "./prompts.js";
import { ClassifierError, type ClassifyInput, type ClassifyOutput, type FailureClassifier } from "./types.js";

export type JevClassifierOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Answer = { choice?: unknown; confidence?: unknown; probabilities?: unknown; noul?: unknown };
type SystemOneResponse = { model?: unknown; answers?: Record<string, Answer>; usage?: { input_tokens?: unknown } };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function normalizeBucketProbabilities(raw: unknown, choice: TriageBucket, confidence: number): Record<TriageBucket, number> {
  const out = { agent_wrong: 0, grader_wrong: 0, case_wrong: 0, unclear: 0 } as Record<TriageBucket, number>;
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  let any = false;
  for (const bucket of TRIAGE_BUCKETS) {
    const p = num(rec[bucket]);
    if (p !== undefined) {
      out[bucket] = clamp01(p);
      any = true;
    }
  }
  if (!any) {
    const rest = (1 - confidence) / (TRIAGE_BUCKETS.length - 1);
    for (const bucket of TRIAGE_BUCKETS) out[bucket] = bucket === choice ? confidence : rest;
  }
  return out;
}

/** System One (TypeSafe Jev) backend. The key goes in one header and is never logged, returned or put in an error. */
export function createJevClassifier(options: JevClassifierOptions): FailureClassifier {
  const model = options.model ?? JEV_MODEL_ID;
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
  const maxRetries = options.maxRetries ?? JEV_MAX_RETRIES;
  const backoff = options.backoffBaseMs ?? JEV_BACKOFF_BASE_MS;
  const sleep = options.sleep ?? defaultSleep;
  const { apiKey } = options;

  async function post(body: unknown, signal: AbortSignal | undefined): Promise<SystemOneResponse> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch {
        if (signal?.aborted) throw new ClassifierError("CLASSIFIER_FAILED", "Classifier request was cancelled");
        throw new ClassifierError("CLASSIFIER_FAILED", "Could not reach the classifier");
      }
      if (res.status === 429) {
        if (attempt >= maxRetries) throw new ClassifierError("CLASSIFIER_RATE_LIMITED", "Classifier rate limit; try again shortly");
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff * 2 ** attempt;
        await res.body?.cancel().catch(() => undefined);
        await sleep(wait);
        continue;
      }
      if (res.status === 422 || res.status === 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new ClassifierError("CLASSIFIER_REJECTED", `Classifier rejected the request (HTTP ${res.status})`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ClassifierError("CLASSIFIER_FAILED", `Classifier request failed (HTTP ${res.status})`);
      }
      try {
        return (await res.json()) as SystemOneResponse;
      } catch {
        throw new ClassifierError("CLASSIFIER_BAD_REPLY", "Classifier reply was not JSON");
      }
    }
  }

  return {
    source: "jev",
    model,
    async classify(input: ClassifyInput): Promise<ClassifyOutput> {
      const types = failureTypesFor(input.targetKind);
      const questions: Record<string, unknown> = {
        bucket: { type: "choice", instructions: BUCKET_QUESTION, criteria: bucketCriteriaMap() },
        failure_type: {
          type: "choice",
          instructions: FAILURE_TYPE_QUESTION,
          criteria: failureTypeCriteriaMap(input.targetKind),
        },
      };
      input.graderQuestions.forEach((q, index) => {
        questions[`false_alarm_${index}`] = { type: "noul", instructions: falseAlarmQuestion(q.graderId) };
      });
      const reply = await post({ model, state: input.state, questions }, input.signal);
      const answers = reply.answers ?? {};

      const bucketAnswer = answers.bucket;
      const choice = bucketAnswer?.choice;
      if (typeof choice !== "string" || !(TRIAGE_BUCKETS as readonly string[]).includes(choice)) {
        throw new ClassifierError("CLASSIFIER_BAD_REPLY", "Classifier gave no valid bucket");
      }
      const bucket = choice as TriageBucket;
      const probsRaw = bucketAnswer?.probabilities;
      const fromProbs = num((probsRaw as Record<string, unknown> | undefined)?.[bucket]);
      const confidence = clamp01(num(bucketAnswer?.confidence) ?? fromProbs ?? 0);
      const failureChoice = answers.failure_type?.choice;
      const failureType =
        typeof failureChoice === "string" && (types as readonly string[]).includes(failureChoice) ? failureChoice : null;
      const graderFalseAlarms = input.graderQuestions.flatMap((q, index) => {
        const p = num(answers[`false_alarm_${index}`]?.noul);
        return p === undefined ? [] : [{ graderId: q.graderId, probability: clamp01(p) }];
      });
      const tokens = num(reply.usage?.input_tokens) ?? 0;
      return {
        bucket,
        confidence,
        bucketProbabilities: normalizeBucketProbabilities(probsRaw, bucket, confidence),
        failureType,
        graderFalseAlarms,
        costUsd: (tokens * JEV_PRICE_INPUT_PER_MILLION_USD) / 1_000_000,
        ...(typeof reply.model === "string" && reply.model.length > 0 ? { answeredModel: reply.model } : {}),
      };
    },
  };
}
