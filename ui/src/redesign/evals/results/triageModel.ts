import type {
  EvalBucket,
  EvalClassifierName,
  EvalClassifierStatus,
  EvalSuggestion,
  EvalSuggestionSummary,
} from "../../../api/evalTypes";
import { formatCost } from "../format";
import type { Tone } from "./headerModel";

export const LOW_CONFIDENCE = 0.7;
export const BUCKETS: EvalBucket[] = ["agent_wrong", "grader_wrong", "case_wrong", "unclear"];

export const BUCKET_LABEL: Record<EvalBucket, string> = {
  agent_wrong: "Agent wrong",
  grader_wrong: "Grader wrong",
  case_wrong: "Case wrong",
  unclear: "Unclear",
};

export const BUCKET_FIX: Record<EvalBucket, string> = {
  agent_wrong: "Change the agent or stage",
  grader_wrong: "Fix the grader",
  case_wrong: "Fix the dataset",
  unclear: "Read it",
};

const BUCKET_TONE: Record<EvalBucket, Tone> = {
  agent_wrong: "fail",
  grader_wrong: "needs",
  case_wrong: "needs",
  unclear: "muted",
};

export const CLASSIFIER_LABEL: Record<EvalClassifierName, string> = { jev: "Jev", judge: "Judge model" };

export const TYPESAFE_KEY_HELP =
  "Add a TypeSafe API key in Settings, Providers, or set STAGEFLOW_PROVIDER_TYPESAFE_API_KEY.";
export const JUDGE_HELP = "You can also sort with the judge model instead.";
export const UNAVAILABLE_TEXT = `No classifier is available. ${TYPESAFE_KEY_HELP} ${JUDGE_HELP}`;

export function formatPercentWhole(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function isLowConfidence(s: Pick<EvalSuggestion, "bucket" | "confidence">): boolean {
  return s.bucket === "unclear" || s.confidence < LOW_CONFIDENCE;
}

export function needsReview(s: EvalSuggestion): boolean {
  return s.status === "pending" && isLowConfidence(s);
}

export type SortButtonView = {
  classifier: EvalClassifierName | null;
  enabled: boolean;
  label: string;
  via: string | null;
  reason: string | null;
};

export function sortButtonView(status: EvalClassifierStatus | null, runActive: boolean): SortButtonView {
  if (runActive) {
    return { classifier: null, enabled: false, label: "Sort failures", via: null, reason: "Wait for the run to finish." };
  }
  if (status === null) {
    return { classifier: null, enabled: false, label: "Sort failures", via: null, reason: "Checking classifiers…" };
  }
  const name = status.default;
  if (name === null) {
    const reasons = [status.classifiers.jev.reason, status.classifiers.judge.reason].filter((r): r is string => !!r);
    return {
      classifier: null,
      enabled: false,
      label: "Sort failures",
      via: null,
      reason: reasons.length > 0 ? `${reasons.join(" ")} ${TYPESAFE_KEY_HELP}` : UNAVAILABLE_TEXT,
    };
  }
  const model = status.classifiers[name].model;
  return {
    classifier: name,
    enabled: true,
    label: "Sort failures",
    via: model ? `${CLASSIFIER_LABEL[name]} · ${model}` : CLASSIFIER_LABEL[name],
    reason: null,
  };
}

/** Shown after a 422 EVAL_CLASSIFIER_UNAVAILABLE; offers the judge when the status says it works. */
export function unavailableView(status: EvalClassifierStatus | null): { text: string; judgeFallback: boolean } {
  const judgeFallback = status?.classifiers.judge.available === true;
  return {
    text: judgeFallback ? `${TYPESAFE_KEY_HELP} Or sort with the judge model instead.` : `${TYPESAFE_KEY_HELP} ${JUDGE_HELP}`,
    judgeFallback,
  };
}

export function sortProgressText(failed: number): string {
  return `Sorting ${failed} failed ${failed === 1 ? "result" : "results"}…`;
}

export function sortDoneText(r: { sorted: number; skipped: number; failed: number; triage_cost_usd: number; model: string }): string {
  const parts = [`Sorted ${r.sorted}`];
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  if (r.failed > 0) parts.push(`${r.failed} could not be sorted`);
  parts.push(`sorting cost ${formatCost(r.triage_cost_usd)}`);
  parts.push(r.model);
  return parts.join(" · ");
}

export type BucketBar = { bucket: EvalBucket; label: string; count: number; fraction: number; tone: Tone; fix: string };

/** Bar width is the share of sorted results; counts come from the API summary. */
export function bucketBars(summary: EvalSuggestionSummary): BucketBar[] {
  const total = BUCKETS.reduce((sum, b) => sum + (summary.by_bucket[b] ?? 0), 0);
  return BUCKETS.map((bucket) => {
    const count = summary.by_bucket[bucket] ?? 0;
    return {
      bucket,
      label: BUCKET_LABEL[bucket],
      count,
      fraction: total > 0 ? count / total : 0,
      tone: BUCKET_TONE[bucket],
      fix: BUCKET_FIX[bucket],
    };
  });
}

export type SuggestedTypeRow = { type: string; count: number; fraction: number };

export function suggestedTypeRows(summary: EvalSuggestionSummary): SuggestedTypeRow[] {
  const entries = Object.entries(summary.by_type).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return entries.map(([type, count]) => ({ type, count, fraction: count / max }));
}

export function acceptableCount(items: EvalSuggestion[]): number {
  return items.filter((s) => s.status === "pending" && !isLowConfidence(s)).length;
}

export type SuggestedView = {
  empty: boolean;
  headline: string;
  bars: BucketBar[];
  types: SuggestedTypeRow[];
  acceptAllText: string;
  acceptAllEnabled: boolean;
  reviewText: string;
  reviewEnabled: boolean;
};

export function suggestedView(summary: EvalSuggestionSummary, items: EvalSuggestion[]): SuggestedView {
  const eligible = acceptableCount(items);
  const review = summary.low_confidence;
  const total = summary.pending + summary.accepted + summary.dismissed;
  return {
    empty: total === 0,
    headline: `${summary.pending} pending · ${summary.accepted} accepted · ${summary.dismissed} dismissed`,
    bars: bucketBars(summary),
    types: suggestedTypeRows(summary),
    acceptAllText: `Accept all above ${Math.round(LOW_CONFIDENCE * 100)}%${eligible > 0 ? ` (${eligible})` : ""}`,
    acceptAllEnabled: eligible > 0,
    reviewText: `Review suggestions${review > 0 ? ` (${review})` : ""}`,
    reviewEnabled: summary.pending > 0,
  };
}

export function acceptDoneText(r: { accepted: number; tagged: number }): string {
  return `Accepted ${r.accepted}, tagged ${r.tagged}.`;
}

export type BucketChipView = { text: string; tone: Tone; low: boolean; title: string };

/** Low confidence is spelled out in the text and drawn dashed, never color alone. */
export function bucketChip(s: EvalSuggestion): BucketChipView {
  const low = isLowConfidence(s);
  const label = BUCKET_LABEL[s.bucket];
  const pct = formatPercentWhole(s.confidence);
  const text = s.bucket === "unclear" ? label : low ? `${label}? · low ${pct}` : label;
  return {
    text,
    tone: low ? "muted" : BUCKET_TONE[s.bucket],
    low,
    title: `${CLASSIFIER_LABEL[s.source]} suggests ${label.toLowerCase()} at ${pct}${low ? " (low confidence)" : ""}`,
  };
}

/** One suggestion per case for list views: pending first, then accepted, never dismissed. */
export function suggestionByCase(items: EvalSuggestion[]): Map<string, EvalSuggestion> {
  const rank = (s: EvalSuggestion) => (s.status === "pending" ? 0 : 1);
  const map = new Map<string, EvalSuggestion>();
  for (const s of items) {
    if (s.status === "dismissed") continue;
    const cur = map.get(s.case_id);
    if (!cur || rank(s) < rank(cur) || (rank(s) === rank(cur) && s.repeat_index < cur.repeat_index)) map.set(s.case_id, s);
  }
  return map;
}

type SuggestionFilter = { bucket?: EvalBucket | null; needsReview?: boolean; suggestedType?: string | null };

export function suggestionFilterActive(f: SuggestionFilter): boolean {
  return !!f.bucket || !!f.needsReview || !!f.suggestedType;
}

export function caseIdsForSuggestionFilter(items: EvalSuggestion[], f: SuggestionFilter): Set<string> {
  const ids = new Set<string>();
  for (const s of items) {
    if (s.status === "dismissed") continue;
    if (f.bucket && s.bucket !== f.bucket) continue;
    if (f.needsReview && !needsReview(s)) continue;
    if (f.suggestedType && s.failure_type !== f.suggestedType) continue;
    ids.add(s.case_id);
  }
  return ids;
}

export type SuggestionLineView = {
  text: string;
  low: boolean;
  lowText: string | null;
  pending: boolean;
  acceptedNote: string | null;
};

export function suggestionLine(s: EvalSuggestion): SuggestionLineView {
  const parts = [BUCKET_LABEL[s.bucket].toLowerCase()];
  const alarm = [...s.grader_false_alarms].sort((a, b) => b.probability - a.probability)[0];
  if (s.bucket === "grader_wrong" && alarm && alarm.probability >= 0.5) parts.push(`false alarm on ${alarm.grader_id}`);
  if (s.failure_type) parts.push(s.failure_type);
  parts.push(formatPercentWhole(s.confidence));
  const low = isLowConfidence(s);
  return {
    text: `${CLASSIFIER_LABEL[s.source]} suggests: ${parts.join(" · ")}`,
    low,
    lowText: low ? "Low confidence: read this one yourself" : null,
    pending: s.status === "pending",
    acceptedNote: s.status === "accepted" ? "Accepted. The tags are in your review below." : null,
  };
}
