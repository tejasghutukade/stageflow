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
