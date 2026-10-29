import type {
  EvalGrade,
  EvalResultDetail,
  EvalReviewInput,
  EvalTryResult,
} from "../../../api/evalTypes";
import { formatCost, formatDuration, formatScore, formatTokens } from "../format";
import type { Tone } from "./headerModel";

export const NOTE_MAX = 500;
export const TAG_MAX = 60;

export type RepeatTab = { index: number; label: string; scoreText: string; tone: Tone };

export function repeatTabs(repeats: EvalResultDetail[]): RepeatTab[] {
  return [...repeats]
    .sort((a, b) => a.repeat_index - b.repeat_index)
    .map((r) => ({
      index: r.repeat_index,
      label: `Repeat ${r.repeat_index + 1}`,
      scoreText: r.score === null ? "" : formatScore(r.score),
      tone: r.passed ? "ok" : "fail",
    }));
}

export function selectRepeat(repeats: EvalResultDetail[], requested: number | undefined): EvalResultDetail | null {
  if (repeats.length === 0) return null;
  const sorted = [...repeats].sort((a, b) => a.repeat_index - b.repeat_index);
  if (requested !== undefined) {
    const found = sorted.find((r) => r.repeat_index === requested);
    if (found) return found;
  }
  return sorted[0]!;
}

export function drawerHeader(evalId: string, runNumber: number, caseIds: string[], caseId: string): string {
  const at = caseIds.indexOf(caseId);
  const position = at >= 0 ? `case ${at + 1} of ${caseIds.length}` : "case";
  return `${evalId} · Run #${runNumber} · ${position}`;
}

export function caseNeighbours(caseIds: string[], caseId: string): { previous: string | null; next: string | null } {
  const at = caseIds.indexOf(caseId);
  if (at < 0) return { previous: null, next: null };
  return { previous: caseIds[at - 1] ?? null, next: caseIds[at + 1] ?? null };
}

export function inputLines(input: unknown): Array<{ key: string; value: string }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input === undefined ? [] : [{ key: "input", value: stringify(input) }];
  }
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({ key, value: stringify(value) }));
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

export const OUTPUT_LINE_LIMIT = 40;

export function flattenPayload(value: unknown, prefix = "", out: string[] = [], depth = 0): string[] {
  if (value !== null && typeof value === "object" && depth < 6) {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((item, i) => [`${prefix}[${i}]`, item] as [string, unknown])
      : Object.entries(value as Record<string, unknown>).map(
          ([key, item]) => [prefix === "" ? key : `${prefix}.${key}`, item] as [string, unknown],
        );
    if (entries.length === 0 && prefix !== "") out.push(`${prefix}: ${Array.isArray(value) ? "[]" : "{}"}`);
    for (const [path, item] of entries) flattenPayload(item, path, out, depth + 1);
    return out;
  }
  if (prefix !== "") out.push(`${prefix}: ${JSON.stringify(value) ?? String(value)}`);
  return out;
}

export type OutputView = { summary: string | null; lines: string[]; moreCount: number; metaText: string };

export function outputMeta(result: Pick<EvalResultDetail, "latency_ms" | "cost_usd" | "tokens_in" | "tokens_out">): string {
  const tokens =
    result.tokens_in === null && result.tokens_out === null
      ? "—"
      : `${formatTokens((result.tokens_in ?? 0) + (result.tokens_out ?? 0))} tokens`;
  return `${formatDuration(result.latency_ms)} · ${formatCost(result.cost_usd)} · ${tokens}`;
}

export function outputView(result: EvalResultDetail): OutputView {
  const output = (result.output ?? {}) as { summary?: unknown; payload?: unknown };
  const all = flattenPayload(output.payload);
  return {
    summary: typeof output.summary === "string" && output.summary.trim() !== "" ? output.summary : null,
    lines: all.slice(0, OUTPUT_LINE_LIMIT),
    moreCount: Math.max(0, all.length - OUTPUT_LINE_LIMIT),
    metaText: outputMeta(result),
  };
}

export function isErrored(result: Pick<EvalResultDetail, "status">): boolean {
  return result.status !== "completed";
}

export function errorView(result: EvalResultDetail): { code: string; message: string } {
  const fallback: Record<string, string> = {
    skipped_budget: "EVAL_BUDGET_EXCEEDED",
    cancelled: "EVAL_CANCELLED",
    needs_input: "EVAL_STAGE_NEEDS_INPUT",
    stage_failed: "EVAL_STAGE_FAILED",
    error: "EVAL_ENGINE_ERROR",
  };
  return {
    code: result.error_code ?? fallback[result.status] ?? result.status,
    message: result.error_message ?? "No further detail was recorded.",
  };
}

export type ExpectedRow = { text: string; found: boolean };

export function expectedFindings(result: EvalResultDetail): ExpectedRow[] | null {
  const grade = result.grades.find((g) => g.grader_type === "reference");
  if (!grade) return null;
  const items = (grade.details as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const rows = items
    .filter((item): item is { text: string; found: boolean } => typeof (item as { text?: unknown })?.text === "string")
    .map((item) => ({ text: item.text, found: item.found === true }));
  return rows.length === 0 ? null : rows;
}

export type GradeRowView = {
  id: string;
  ok: boolean | null;
  valueText: string;
  reason: string | null;
  failed: boolean;
  /** A rubric or goal grader: the author can record their own verdict on it. */
  judged: boolean;
  humanLabel: "pass" | "fail" | null;
};

export function isJudgedGrader(type: string): boolean {
  return type === "rubric" || type === "goal_reached";
}

function gradeValueText(grade: EvalGrade): string {
  if (grade.status === "error") return "error";
  if (grade.score === null) return grade.passed ? "pass" : "fail";
  if (grade.raw_value !== null && Math.abs(grade.raw_value - grade.score) > 1e-9 && grade.raw_value >= 1 && grade.raw_value <= 5) {
    return `${grade.raw_value} / 5`;
  }
  if (grade.grader_type === "schema" || (grade.grader_type === "rubric" && grade.raw_value === grade.score)) {
    return grade.passed ? "pass" : "fail";
  }
  return formatScore(grade.score);
}

export function gradeRows(result: EvalResultDetail): GradeRowView[] {
  return result.grades.map((grade) => {
    const errored = grade.status === "error";
    const failed = errored || grade.passed === false;
    let reason: string | null = null;
    if (errored) {
      reason = [grade.error_code, grade.reason].filter((part): part is string => !!part).join(": ") || "Grader error";
    } else if (failed) {
      reason = grade.reason;
    }
    return {
      id: grade.grader_id,
      ok: errored ? null : grade.passed === true,
      valueText: gradeValueText(grade),
      reason,
      failed,
      judged: !errored && isJudgedGrader(grade.grader_type),
      humanLabel: result.grader_labels?.[grade.grader_id]?.label ?? null,
    };
  });
}

export type ReviewState = {
  label: "pass" | "fail" | null;
  note: string;
  tags: string[];
  saved: { label: "pass" | "fail" | null; note: string; tags: string[] };
};

export function initReview(result: EvalResultDetail): ReviewState {
  const label = result.review?.label ?? null;
  const note = result.review?.note ?? "";
  const tags = [...result.tags];
  return { label, note, tags, saved: { label, note, tags: [...tags] } };
}

export function tagsEnabled(result: Pick<EvalResultDetail, "passed">): boolean {
  return !result.passed;
}

export function setLabel(state: ReviewState, label: "pass" | "fail"): ReviewState {
  return { ...state, label };
}

export function setNote(state: ReviewState, note: string): ReviewState {
  return { ...state, note: note.slice(0, NOTE_MAX) };
}

export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().replace(/\s+/g, " ");
  return tag === "" || tag.length > TAG_MAX ? null : tag;
}

export function hasTag(tags: string[], tag: string): boolean {
  return tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

export function toggleTag(state: ReviewState, tag: string, enabled: boolean): ReviewState {
  if (!enabled) return state;
  const tags = hasTag(state.tags, tag)
    ? state.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
    : [...state.tags, tag];
  return { ...state, tags };
}

export function addNewTag(state: ReviewState, raw: string, enabled: boolean): ReviewState {
  const tag = normalizeTag(raw);
  if (!enabled || tag === null || hasTag(state.tags, tag)) return state;
  return { ...state, tags: [...state.tags, tag] };
}

function sameTags(a: string[], b: string[]): boolean {
  const key = (tags: string[]) => tags.map((t) => t.toLowerCase()).sort().join("\n");
  return key(a) === key(b);
}

export function isDirty(state: ReviewState): boolean {
  return (
    state.label !== state.saved.label ||
    state.note.trim() !== state.saved.note.trim() ||
    !sameTags(state.tags, state.saved.tags)
  );
}

export function canSave(state: ReviewState): boolean {
  return state.label !== null && isDirty(state);
}

export function buildSaveRequest(state: ReviewState, result: Pick<EvalResultDetail, "passed">): EvalReviewInput | null {
  if (state.label === null) return null;
  const request: EvalReviewInput = { label: state.label };
  const note = state.note.trim();
  if (note !== "") request.note = note;
  else if (state.saved.note.trim() !== "") request.note = null;
  if (tagsEnabled(result)) request.tags = state.tags;
  return request;
}

export function afterSave(saved: { label: "pass" | "fail" | null; note: string | null; tags: string[] }): ReviewState {
  const note = saved.note ?? "";
  return {
    label: saved.label,
    note,
    tags: [...saved.tags],
    saved: { label: saved.label, note, tags: [...saved.tags] },
  };
}

export function agreementLine(
  result: Pick<EvalResultDetail, "passed" | "repeat_index">,
  label: "pass" | "fail" | null,
): string | null {
  if (label === null) return null;
  const system = result.passed ? "pass" : "fail";
  if (label === system) return `The judge also said ${system} for repeat ${result.repeat_index + 1}. You agree.`;
  return "You disagree with the grade.";
}

export type RerunPanelView = {
  title: string;
  verdict: string;
  verdictTone: Tone;
  scoreText: string;
  summary: string | null;
  grades: GradeRowView[];
  metaText: string;
  error: { code: string; message: string } | null;
};

export function rerunPanelView(result: EvalTryResult): RerunPanelView {
  const r = result.result;
  const errored = isErrored(r);
  return {
    title: "Re-run · not stored",
    verdict: errored ? "Errored" : r.passed ? "Passed" : "Failed",
    verdictTone: errored || !r.passed ? "fail" : "ok",
    scoreText: formatScore(r.score),
    summary: outputView(r).summary,
    grades: errored ? [] : gradeRows(r),
    metaText: `${formatDuration(r.latency_ms)} · ${formatCost(result.cost_usd)}`,
    error: errored ? errorView(r) : null,
  };
}
