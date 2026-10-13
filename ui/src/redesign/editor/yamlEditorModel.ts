import { isMap, isScalar, parseDocument, type YAMLMap } from "yaml";
import type { DraftPackagePayload } from "../../api";
import { draftFileYaml, normalizeYamlPath, yamlDisplayLines, yamlPathsMatch } from "./draftYaml";
import type { YamlToken } from "./yamlHighlight";

export const YAML_LINE_HEIGHT = 20;
export const YAML_PADDING_TOP = 10;

export type YamlEditError = { message: string; line: number; column: number };

export type YamlParseError = YamlEditError & { path: string };

export type YamlEditResult =
  | { ok: true; draft: DraftPackagePayload }
  | { ok: false; error: YamlEditError };

export type YamlLineRange = { start: number; end: number };

export function cursorLineCol(text: string, offset: number): { line: number; column: number } {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

export function isPipelineYamlPath(path: string | null, pipelinePath: string | null): boolean {
  if (!path || !pipelinePath) return false;
  return normalizeYamlPath(path) === normalizeYamlPath(pipelinePath);
}

function keyOffset(map: YAMLMap, key: string): number {
  for (const pair of map.items) {
    if (!isScalar(pair.key) || pair.key.value !== key) continue;
    const node = (pair.value ?? pair.key) as { range?: [number, number, number] };
    return node.range?.[0] ?? pair.key.range?.[0] ?? 0;
  }
  return 0;
}

function editError(text: string, message: string, offset: number): YamlEditResult {
  return { ok: false, error: { message, ...cursorLineCol(text, offset) } };
}

export function applyYamlEdit(
  draft: DraftPackagePayload,
  path: string,
  pipelinePath: string | null,
  text: string,
): YamlEditResult {
  const doc = parseDocument(text, { prettyErrors: false });
  const first = doc.errors[0];
  if (first) return editError(text, first.message, first.pos[0]);
  if (!isMap(doc.contents)) {
    return editError(text, "Expected a mapping at the document root", 0);
  }
  const root = doc.contents;
  const value = doc.toJS() as Record<string, unknown>;
  if (isPipelineYamlPath(path, pipelinePath)) {
    if (typeof value.id !== "string" || value.id.trim() === "") {
      return editError(text, "Pipeline needs a string id", keyOffset(root, "id"));
    }
    if (!Array.isArray(value.stages)) {
      return editError(text, "Pipeline needs a stages list", keyOffset(root, "stages"));
    }
    return {
      ok: true,
      draft: { ...draft, pipeline: value as DraftPackagePayload["pipeline"] },
    };
  }
  const files = draft.stages ?? [];
  const index = files.findIndex((file) => yamlPathsMatch(file.path, path));
  if (index < 0) return editError(text, `Unknown stage file ${path}`, 0);
  return {
    ok: true,
    draft: {
      ...draft,
      stages: files.map((file, i) => (i === index ? { ...file, body: value } : file)),
    },
  };
}

export function yamlTextMatchesDraft(
  draft: DraftPackagePayload,
  path: string,
  pipelinePath: string | null,
  text: string,
): boolean {
  const parsed = applyYamlEdit(draft, path, pipelinePath, text);
  if (!parsed.ok) return false;
  return (
    draftFileYaml(parsed.draft, path, pipelinePath) === draftFileYaml(draft, path, pipelinePath)
  );
}

export function yamlEditChangesDraft(
  draft: DraftPackagePayload,
  next: DraftPackagePayload,
): boolean {
  return (
    JSON.stringify(draft.pipeline) !== JSON.stringify(next.pipeline) ||
    JSON.stringify(draft.stages ?? []) !== JSON.stringify(next.stages ?? [])
  );
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isComment(line: string): boolean {
  return line.trim().startsWith("#");
}

function scalarText(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function stageEntryLineRange(yamlText: string, stageId: string): YamlLineRange | null {
  const lines = yamlText.split("\n");
  const stagesIndex = lines.findIndex((line) => /^stages:\s*(#.*)?$/.test(line));
  if (stagesIndex < 0) return null;
  let itemIndent: number | null = null;
  let blockEnd = lines.length;
  const items: number[] = [];
  for (let i = stagesIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line) || isComment(line)) continue;
    const indent = indentOf(line);
    const isItem = line.trimStart().startsWith("- ") || line.trim() === "-";
    if (itemIndent === null) {
      if (!isItem) return null;
      itemIndent = indent;
    }
    if (indent < itemIndent || (indent === itemIndent && !isItem)) {
      blockEnd = i;
      break;
    }
    if (indent === itemIndent && isItem) items.push(i);
  }
  if (itemIndent === null) return null;
  const idPattern = /^id:\s*(.*)$/;
  for (let n = 0; n < items.length; n += 1) {
    const start = items[n]!;
    let end = (items[n + 1] ?? blockEnd) - 1;
    while (end > start && isBlank(lines[end]!)) end -= 1;
    let found: string | null = null;
    for (let i = start; i <= end && found === null; i += 1) {
      const line = lines[i]!;
      const content =
        i === start ? line.slice(itemIndent).replace(/^-\s*/, "") : line.trimStart();
      if (i !== start && indentOf(line) !== itemIndent + 2) continue;
      const match = idPattern.exec(content);
      if (match) found = scalarText(match[1]!);
    }
    if (found === stageId) return { start: start + 1, end: end + 1 };
  }
  return null;
}

function isValueToken(token: YamlToken): boolean {
  return (token.kind === "plain" || token.kind === "string") && token.text.trim() !== "";
}

export function findingTokenIndex(tokens: YamlToken[], column?: number): number {
  const keyIndex = tokens.findIndex((token) => token.kind === "key");
  const firstValue = tokens.findIndex(
    (token, index) => index > keyIndex && isValueToken(token),
  );
  if (typeof column !== "number" || !Number.isInteger(column) || column < 1) {
    return firstValue;
  }
  const target = column - 1;
  let offset = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const end = offset + token.text.length;
    if (end > target && isValueToken(token)) return index;
    offset = end;
  }
  return firstValue;
}

export function yamlTabLabel(path: string, pipelinePath: string | null): string {
  const normalized = normalizeYamlPath(path);
  if (isPipelineYamlPath(path, pipelinePath)) {
    return normalized.split("/").pop() ?? normalized;
  }
  if (pipelinePath) {
    const pipeline = normalizeYamlPath(pipelinePath);
    const slash = pipeline.lastIndexOf("/");
    const dir = slash >= 0 ? pipeline.slice(0, slash + 1) : "";
    if (dir && normalized.startsWith(dir)) return normalized.slice(dir.length);
  }
  return normalized;
}

export function yamlTabPaths(
  pipelinePath: string,
  openPaths: readonly (string | null | undefined)[],
): string[] {
  const out = [pipelinePath];
  const seen = new Set([normalizeYamlPath(pipelinePath)]);
  for (const path of openPaths) {
    if (!path) continue;
    const key = normalizeYamlPath(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function isYamlPathDirty(dirtyPaths: ReadonlySet<string>, path: string): boolean {
  if (dirtyPaths.has(normalizeYamlPath(path))) return true;
  for (const dirty of dirtyPaths) if (yamlPathsMatch(dirty, path)) return true;
  return false;
}

export function yamlFooterCounts(text: string, stageCount: number): string {
  const lines = yamlDisplayLines(text).length;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${stageCount} ${
    stageCount === 1 ? "stage" : "stages"
  }`;
}

export function yamlLineTop(line: number): number {
  return YAML_PADDING_TOP + (line - 1) * YAML_LINE_HEIGHT;
}

export function revealLineScrollTop(
  line: number,
  scrollTop: number,
  viewHeight: number,
): number {
  const top = yamlLineTop(line);
  const bottom = top + YAML_LINE_HEIGHT;
  if (top - YAML_PADDING_TOP < scrollTop) return Math.max(0, top - YAML_PADDING_TOP);
  if (bottom + YAML_PADDING_TOP > scrollTop + viewHeight) {
    return Math.max(0, bottom + YAML_PADDING_TOP - viewHeight);
  }
  return scrollTop;
}

export function revealColumnScrollLeft(
  column: number,
  charWidth: number,
  gutterWidth: number,
  scrollLeft: number,
  viewWidth: number,
): number {
  const x = gutterWidth + (column - 1) * charWidth;
  if (x < scrollLeft + gutterWidth) return Math.max(0, x - gutterWidth);
  if (x + charWidth * 2 > scrollLeft + viewWidth) {
    return Math.max(0, x + charWidth * 2 - viewWidth);
  }
  return scrollLeft;
}

export function centerLineScrollTop(line: number, viewHeight: number): number {
  return Math.max(0, yamlLineTop(line) + YAML_LINE_HEIGHT / 2 - viewHeight / 2);
}
