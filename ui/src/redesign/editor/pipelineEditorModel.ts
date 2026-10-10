import type {
  DraftPackagePayload,
  DraftValidationResult,
  PipelineListing,
  ValidationFinding,
} from "../../api";
import { locateFindingField } from "../workshop/inspector/stageFields";

export const EDITOR_TAB_IDS = ["editor", "runs", "history"] as const;

export type EditorTabId = (typeof EDITOR_TAB_IDS)[number];

export type EditorTabSpec = {
  id: EditorTabId;
  label: string;
  count?: number;
};

export type EditorValidationPills = {
  strictLabel: "Valid · strict" | "Invalid · strict";
  strictSignal: "ok" | "fail";
  warningLabel: string;
  warningCount: number;
  warningSignal: "ok" | "needs";
};

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObj(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function isDraftDirty(
  draft: DraftPackagePayload | null,
  baseline: DraftPackagePayload | null,
): boolean {
  if (!draft || !baseline) return false;
  return stableStringify(draft) !== stableStringify(baseline);
}

export function warningPillLabel(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

export function editorValidationPills(
  validation: DraftValidationResult | null,
): EditorValidationPills | null {
  if (!validation) return null;
  const warningCount = validation.summary.warnings;
  return {
    strictLabel: validation.ok ? "Valid · strict" : "Invalid · strict",
    strictSignal: validation.ok ? "ok" : "fail",
    warningLabel: warningPillLabel(warningCount),
    warningCount,
    warningSignal: warningCount > 0 ? "needs" : "ok",
  };
}

export function isEditorTabId(value: string): value is EditorTabId {
  return (EDITOR_TAB_IDS as readonly string[]).includes(value);
}

function normalizeCatalogPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameCatalogRoot(left?: string, right?: string): boolean {
  const a = left?.trim().replace(/\\/g, "/").replace(/\/$/, "") ?? "";
  const b = right?.trim().replace(/\\/g, "/").replace(/\/$/, "") ?? "";
  return a === b;
}

export function filterEditorPipelineRuns<
  T extends { pipeline_id: string; project_root?: string },
>(
  runs: readonly T[],
  pipeline: { id: string; project_root?: string },
): T[] {
  return runs.filter(
    (run) =>
      run.pipeline_id === pipeline.id &&
      sameCatalogRoot(run.project_root, pipeline.project_root),
  );
}

function sameStagePath(left: string, right: string): boolean {
  const a = normalizeCatalogPath(left);
  const b = normalizeCatalogPath(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function stageUsedByCount(
  pipelines: readonly PipelineListing[] | null | undefined,
  stage: { id: string; path: string | null; projectRoot?: string },
): number | null {
  if (!pipelines) return null;
  const ids = new Set<string>();
  for (const pipeline of pipelines) {
    if (!sameCatalogRoot(pipeline.project_root, stage.projectRoot)) continue;
    const listed = pipeline.stages.some((row) => {
      if (row.id === stage.id) return true;
      return (
        stage.path != null &&
        row.uses_path != null &&
        sameStagePath(row.uses_path, stage.path)
      );
    });
    if (listed) ids.add(pipeline.id);
  }
  return ids.size;
}

export function editorTabSpecs(runsCount?: number): EditorTabSpec[] {
  const runs: EditorTabSpec = { id: "runs", label: "Runs" };
  if (runsCount != null) runs.count = runsCount;
  return [
    { id: "editor", label: "Editor" },
    runs,
    { id: "history", label: "History" },
  ];
}

export function findingDedupeKey(finding: ValidationFinding): string {
  return `${finding.code}\0${finding.path}\0${finding.message}`;
}

export function mergeEditorFindings(
  draftFindings: readonly ValidationFinding[],
  catalogFindings: readonly ValidationFinding[],
): ValidationFinding[] {
  const seen = new Set<string>();
  const merged: ValidationFinding[] = [];
  for (const finding of [...draftFindings, ...catalogFindings]) {
    const key = findingDedupeKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}

export function problemCounts(findings: readonly ValidationFinding[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1;
    else if (finding.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}

export type EditorFindingFocus =
  | { kind: "stage"; stageId: string; field: string }
  | { kind: "row" };

export function focusEditorFinding(
  finding: ValidationFinding,
  draft: DraftPackagePayload,
): EditorFindingFocus {
  const located = locateFindingField(finding, draft);
  if (located) {
    return { kind: "stage", stageId: located.stageId, field: located.field };
  }
  return { kind: "row" };
}

export function lastValidatedFooter(elapsedMs: number | null): string {
  const timing =
    elapsedMs === null || !Number.isFinite(elapsedMs)
      ? "—"
      : `${Math.max(0, Math.round(elapsedMs))}ms`;
  return `Last validated · sf validate --strict · ${timing}`;
}

const EDITOR_HISTORY_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const FINISHED_EDITOR_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export type EditorHistorySessionEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
};

export type EditorHistoryRunRef = {
  run_id: string;
  status: string;
  created_at: string;
  updated_at?: string;
  finished_at?: string;
  waiting_stage_id?: string;
};

export type EditorHistoryEntry =
  | {
      source: "session";
      id: string;
      at: string;
      label: string;
      detail?: string;
    }
  | {
      source: "run";
      id: string;
      at: string;
      runId: string;
      status: string;
    };

export type EditorHistoryGroup = {
  day: string;
  label: string;
  entries: EditorHistoryEntry[];
};

export function isFinishedEditorRun(run: {
  status: string;
  waiting_stage_id?: string;
}): boolean {
  if (run.waiting_stage_id) return false;
  return FINISHED_EDITOR_RUN_STATUSES.has(run.status);
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function editorHistoryDayLabel(dayKey: string, now: number): string {
  if (dayKey === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  if (dayKey === localDayKey(yesterday.getTime())) return "Yesterday";
  const [yearText, monthText, dayText] = dayKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!year || month < 1 || month > 12 || !day) return dayKey;
  const yearSuffix = year === new Date(now).getFullYear() ? "" : ` ${year}`;
  return `${EDITOR_HISTORY_MONTHS[month - 1]} ${day}${yearSuffix}`;
}

function finishedRunAt(run: EditorHistoryRunRef): string | null {
  if (!isFinishedEditorRun(run)) return null;
  const raw = run.finished_at ?? run.updated_at ?? run.created_at;
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return raw;
}

export function mergeEditorHistory<T extends EditorHistoryRunRef>(input: {
  events: readonly EditorHistorySessionEvent[];
  runs: readonly T[];
  now?: number;
}): EditorHistoryGroup[] {
  const now = input.now ?? Date.now();
  const ranked: Array<EditorHistoryEntry & { seq: number }> = [];

  input.events.forEach((event, index) => {
    if (!Number.isFinite(Date.parse(event.at))) return;
    ranked.push({
      source: "session",
      id: event.id,
      at: event.at,
      label: event.label,
      ...(event.detail ? { detail: event.detail } : {}),
      seq: index,
    });
  });

  const seenRuns = new Set<string>();
  for (const run of input.runs) {
    if (seenRuns.has(run.run_id)) continue;
    const at = finishedRunAt(run);
    if (!at) continue;
    seenRuns.add(run.run_id);
    ranked.push({
      source: "run",
      id: `run:${run.run_id}`,
      at,
      runId: run.run_id,
      status: run.status,
      seq: -1,
    });
  }

  ranked.sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    if (delta !== 0) return delta;
    if (a.source !== b.source) return a.source === "session" ? -1 : 1;
    return b.seq - a.seq;
  });

  const groups: EditorHistoryGroup[] = [];
  for (const entry of ranked) {
    const day = localDayKey(Date.parse(entry.at));
    const item = toHistoryEntry(entry);
    const last = groups[groups.length - 1];
    if (!last || last.day !== day) {
      groups.push({
        day,
        label: editorHistoryDayLabel(day, now),
        entries: [item],
      });
    } else {
      last.entries.push(item);
    }
  }
  return groups;
}

function toHistoryEntry(
  entry: EditorHistoryEntry & { seq: number },
): EditorHistoryEntry {
  if (entry.source === "session") {
    return {
      source: "session",
      id: entry.id,
      at: entry.at,
      label: entry.label,
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
  }
  return {
    source: "run",
    id: entry.id,
    at: entry.at,
    runId: entry.runId,
    status: entry.status,
  };
}
