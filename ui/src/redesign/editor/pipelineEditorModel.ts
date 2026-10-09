import type { DraftPackagePayload, DraftValidationResult } from "../../api";

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

export function editorTabSpecs(runsCount: number): EditorTabSpec[] {
  return [
    { id: "editor", label: "Editor" },
    { id: "runs", label: "Runs", count: runsCount },
    { id: "history", label: "History" },
  ];
}
