import type {
  DraftPackagePayload,
  DraftValidationResult,
  ValidationFinding,
} from "../../api";
import {
  draftFileYaml,
  normalizeYamlPath,
  serializeYamlDocument,
  yamlPathsMatch,
} from "./draftYaml";
import { headerPills, type HeaderPills } from "./editorHeaderModel";
import { focusEditorFinding } from "./pipelineEditorModel";
import {
  editorInfoFindings,
  resolveFindingLine,
  type EditorFinding,
} from "./editorProblemsModel";
import type { YamlParseError } from "./yamlEditorModel";

export const EDITOR_YAML_DEFAULT_WIDTH = 400;
export const EDITOR_YAML_MIN_WIDTH = 280;
export const EDITOR_YAML_MAX_WIDTH = 720;

export const EDITOR_INSPECTOR_DEFAULT_WIDTH = 300;
export const EDITOR_INSPECTOR_MIN_WIDTH = 240;
export const EDITOR_INSPECTOR_MAX_WIDTH = 480;

export function clampEditorYamlWidth(width: number): number {
  return Math.max(EDITOR_YAML_MIN_WIDTH, Math.min(EDITOR_YAML_MAX_WIDTH, width));
}

export function clampEditorInspectorWidth(width: number): number {
  return Math.max(
    EDITOR_INSPECTOR_MIN_WIDTH,
    Math.min(EDITOR_INSPECTOR_MAX_WIDTH, width),
  );
}

function basename(path: string): string {
  const normalized = normalizeYamlPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function samePath(left: string, right: string): boolean {
  if (yamlPathsMatch(left, right)) return true;
  const a = basename(left);
  return a !== "" && a === basename(right);
}

export function normalizeFindingPath(
  path: string,
  pipelinePath: string,
  stagePaths: readonly string[],
): string {
  if (samePath(path, pipelinePath)) return pipelinePath;
  const stage = stagePaths.find((candidate) => samePath(path, candidate));
  return stage ?? path;
}

export function parseErrorFinding(error: YamlParseError): EditorFinding {
  return {
    severity: "error",
    code: "yaml/parse",
    category: "yaml",
    path: error.path,
    message: error.message,
    line: error.line,
    column: error.column,
  };
}

export function editorPanelFindings(
  draft: DraftPackagePayload,
  pipelinePath: string,
  backend: readonly ValidationFinding[],
  parseError: YamlParseError | null,
): EditorFinding[] {
  const stagePaths = (draft.stages ?? []).map((file) => file.path);
  const rows: EditorFinding[] = [
    ...(parseError ? [parseErrorFinding(parseError)] : []),
    ...backend,
    ...editorInfoFindings(draft, pipelinePath),
  ];
  return rows.map((row) => {
    const finding = { ...row, path: normalizeFindingPath(row.path, pipelinePath, stagePaths) };
    const resolved = resolveFindingLine(draft, pipelinePath, finding);
    const next: EditorFinding = { ...finding, path: resolved.path };
    delete next.line;
    delete next.lineEnd;
    delete next.column;
    if (resolved.line !== undefined) next.line = resolved.line;
    if (resolved.lineEnd !== undefined) next.lineEnd = resolved.lineEnd;
    if (resolved.column !== undefined) next.column = resolved.column;
    return next;
  });
}

export function editorDirtyPaths(
  draft: DraftPackagePayload | null,
  baseline: DraftPackagePayload | null,
  pipelinePath: string,
): Set<string> {
  const dirty = new Set<string>();
  if (!draft || !baseline) return dirty;
  if (
    draftFileYaml(draft, pipelinePath, pipelinePath) !==
    draftFileYaml(baseline, pipelinePath, pipelinePath)
  ) {
    dirty.add(normalizeYamlPath(pipelinePath));
  }
  for (const file of draft.stages ?? []) {
    const before = (baseline.stages ?? []).find((entry) => yamlPathsMatch(entry.path, file.path));
    if (!before || serializeYamlDocument(before.body) !== serializeYamlDocument(file.body)) {
      dirty.add(normalizeYamlPath(file.path));
    }
  }
  return dirty;
}

export function editorFindingTarget(
  finding: EditorFinding,
  draft: DraftPackagePayload,
): { stageId: string; field: string | null } | null {
  const focus = focusEditorFinding(
    { ...finding, severity: finding.severity === "info" ? "warning" : finding.severity },
    draft,
  );
  if (focus.kind === "stage") return { stageId: focus.stageId, field: focus.field };
  return finding.stageId ? { stageId: finding.stageId, field: null } : null;
}

export function editorStageFindings(
  findings: readonly EditorFinding[],
): Map<string, "error" | "warning"> {
  const map = new Map<string, "error" | "warning">();
  for (const finding of findings) {
    if (!finding.stageId || finding.severity === "info") continue;
    if (map.get(finding.stageId) === "error") continue;
    map.set(finding.stageId, finding.severity);
  }
  return map;
}

export function editorHeaderPills(
  result: DraftValidationResult | null,
  hasParseError: boolean,
): HeaderPills | null {
  if (!hasParseError) return headerPills(result);
  const summary = result?.summary ?? { errors: 0, warnings: 0 };
  return headerPills({
    scope: result?.scope ?? "full",
    ok: false,
    summary: { errors: summary.errors + 1, warnings: summary.warnings },
    findings: result?.findings ?? [],
  });
}

export function draftSchemaCount(draft: DraftPackagePayload | null): number {
  const schemas = draft?.pipeline.schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) return 0;
  return Object.keys(schemas).length;
}
