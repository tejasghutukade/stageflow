import { LOW_CONFIDENCE_THRESHOLD, TRIAGE_BUCKETS, type TriageBucket } from "../triage/constants.js";
import type { SuggestionRow } from "../triage/types.js";

export type WireSuggestion = {
  id: string;
  case_id: string;
  repeat_index: number;
  source: "jev" | "judge";
  bucket: TriageBucket;
  failure_type: string | null;
  confidence: number;
  bucket_probabilities: Record<TriageBucket, number>;
  grader_false_alarms: Array<{ grader_id: string; probability: number }>;
  model: string;
  prompt_version: number;
  status: "pending" | "accepted" | "dismissed";
  created_at: string;
};

export type SuggestionSummary = {
  by_bucket: Record<TriageBucket, number>;
  by_type: Record<string, number>;
  pending: number;
  accepted: number;
  dismissed: number;
  low_confidence: number;
};

export function suggestionToWire(row: SuggestionRow): WireSuggestion {
  return {
    id: row.id,
    case_id: row.caseId,
    repeat_index: row.repeatIndex,
    source: row.source,
    bucket: row.bucket,
    failure_type: row.failureType,
    confidence: row.confidence,
    bucket_probabilities: row.bucketProbabilities,
    grader_false_alarms: row.graderFalseAlarms.map((a) => ({ grader_id: a.graderId, probability: a.probability })),
    model: row.model,
    prompt_version: row.promptVersion,
    status: row.status,
    created_at: row.createdAt,
  };
}

export function isLowConfidence(row: Pick<SuggestionRow, "bucket" | "confidence">): boolean {
  return row.bucket === "unclear" || row.confidence < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * One suggestion stands for a result: the newest that is not dismissed, else the newest dismissed. A result sorted by
 * both backends therefore counts once. Ties on time keep the later source name so the choice is stable.
 */
export function representatives(rows: readonly SuggestionRow[]): SuggestionRow[] {
  const best = new Map<string, SuggestionRow>();
  const rank = (row: SuggestionRow): [number, string, string] => [row.status === "dismissed" ? 0 : 1, row.createdAt, row.source];
  for (const row of rows) {
    const key = `${row.caseId}\u0000${row.repeatIndex}`;
    const current = best.get(key);
    if (current === undefined) {
      best.set(key, row);
      continue;
    }
    const [a, b] = [rank(row), rank(current)];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best.set(key, row);
  }
  return [...best.values()];
}

/**
 * Counts per result (see `representatives`). `by_bucket`, `by_type` and `low_confidence` count suggestions that are not
 * dismissed; `pending`, `accepted` and `dismissed` count every representative by status. A null failure type is not
 * counted in `by_type`. Low confidence means the bucket is `unclear` or its confidence is below 0.7.
 */
export function buildSuggestionSummary(rows: readonly SuggestionRow[]): SuggestionSummary {
  const summary: SuggestionSummary = {
    by_bucket: Object.fromEntries(TRIAGE_BUCKETS.map((b) => [b, 0])) as Record<TriageBucket, number>,
    by_type: {},
    pending: 0,
    accepted: 0,
    dismissed: 0,
    low_confidence: 0,
  };
  for (const row of representatives(rows)) {
    summary[row.status] += 1;
    if (row.status === "dismissed") continue;
    summary.by_bucket[row.bucket] += 1;
    if (row.failureType !== null) summary.by_type[row.failureType] = (summary.by_type[row.failureType] ?? 0) + 1;
    if (isLowConfidence(row)) summary.low_confidence += 1;
  }
  return summary;
}

/** The suggestion shown for one result in the case drawer: its representative, or null. */
export function suggestionFor(rows: readonly SuggestionRow[], caseId: string, repeatIndex: number): WireSuggestion | null {
  const own = rows.filter((r) => r.caseId === caseId && r.repeatIndex === repeatIndex);
  const [rep] = representatives(own);
  return rep === undefined ? null : suggestionToWire(rep);
}
