import type { DraftPackagePayload, DraftValidationResult } from "../../api";
import { normalizeYamlPath, pipelineYamlDocument } from "./draftYaml";

export type HeaderPills = {
  strictLabel: string;
  strictOk: boolean;
  warningLabel: string;
  warningCount: number;
  errorCount: number;
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

function stageBodyFingerprints(
  draft: DraftPackagePayload,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of draft.stages ?? []) {
    map.set(normalizeYamlPath(file.path), stableStringify(file.body));
  }
  return map;
}

export function unsavedChangeCount(
  draft: DraftPackagePayload | null,
  baseline: DraftPackagePayload | null,
): number {
  if (!draft || !baseline) return 0;
  let count = 0;
  const draftPipeline = stableStringify(pipelineYamlDocument(draft.pipeline));
  const baselinePipeline = stableStringify(
    pipelineYamlDocument(baseline.pipeline),
  );
  if (draftPipeline !== baselinePipeline) count += 1;

  const draftStages = stageBodyFingerprints(draft);
  const baselineStages = stageBodyFingerprints(baseline);
  const paths = new Set([
    ...draftStages.keys(),
    ...baselineStages.keys(),
  ]);
  for (const path of paths) {
    if (draftStages.get(path) !== baselineStages.get(path)) count += 1;
  }
  return count;
}

function errorPillLabel(count: number): string {
  return count === 1 ? "1 error" : `${count} errors`;
}

function warningPillLabel(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

export function headerPills(
  result: DraftValidationResult | null,
): HeaderPills | null {
  if (!result) return null;
  const errorCount = result.summary.errors;
  const warningCount = result.summary.warnings;
  const strictOk = errorCount === 0;
  return {
    strictLabel: strictOk ? "Valid · strict" : errorPillLabel(errorCount),
    strictOk,
    warningLabel: warningPillLabel(warningCount),
    warningCount,
    errorCount,
  };
}
