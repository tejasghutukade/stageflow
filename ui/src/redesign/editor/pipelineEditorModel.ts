import type {
  DraftPackagePayload,
  DraftValidationResult,
  PipelineListing,
} from "../../api";

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

export function editorTabSpecs(runsCount: number): EditorTabSpec[] {
  return [
    { id: "editor", label: "Editor" },
    { id: "runs", label: "Runs", count: runsCount },
    { id: "history", label: "History" },
  ];
}
