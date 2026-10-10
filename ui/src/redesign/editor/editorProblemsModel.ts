import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type ParsedNode,
  type Range,
  type YAMLMap,
} from "yaml";
import type { DraftPackagePayload, ValidationFinding } from "../../api";
import { stageIdFromRef } from "./draftMutators";
import { draftFileYaml, normalizeYamlPath } from "./draftYaml";
import { buildEditorLiveGraph } from "./editorLiveGraph";
import { focusEditorFinding } from "./pipelineEditorModel";
import { needsTargets, stageIds, stageRefFor } from "../workshop/stageMutators";

export type EditorFinding = Omit<ValidationFinding, "severity"> & {
  severity: "error" | "warning" | "info";
  lineEnd?: number;
};

export type ResolvedFindingLine = {
  path: string;
  line?: number;
  lineEnd?: number;
  column?: number;
};

type YamlMap = YAMLMap<ParsedNode, ParsedNode | null>;

type KeyPos = { line: number; column: number };

type StageEntry = {
  stageId: string;
  startLine: number;
  endLine: number;
  map: YamlMap | null;
};

const FIELD_KEYS: Record<string, readonly string[]> = {
  id: ["id"],
  model: ["model"],
  system_prompt: ["system_prompt"],
  "verify.command": ["verify", "completion", "pre_emit_checks"],
  on_verify_fail: ["on_verify_fail", "recovery"],
  ask_operator: ["gate_kinds", "ask_operator"],
};

function knownPositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function findingPathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function basename(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function asValidationFinding(finding: EditorFinding): ValidationFinding {
  return {
    severity: finding.severity === "info" ? "warning" : finding.severity,
    code: finding.code,
    path: finding.path,
    message: finding.message,
    category: finding.category,
    ...(finding.pipelineId !== undefined ? { pipelineId: finding.pipelineId } : {}),
    ...(finding.stageId !== undefined ? { stageId: finding.stageId } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.column !== undefined ? { column: finding.column } : {}),
  };
}

function isPipelineYaml(path: string, pipelinePath: string): boolean {
  if (!path || !pipelinePath) return false;
  return normalizeYamlPath(path) === normalizeYamlPath(pipelinePath);
}

function lineAt(counter: LineCounter, offset: number): number {
  return counter.linePos(offset).line;
}

function columnAt(counter: LineCounter, offset: number): number {
  return counter.linePos(offset).col;
}

function bounds(counter: LineCounter, range: Range): { start: number; end: number } {
  const start = lineAt(counter, range[0]);
  const endOffset = Math.max(range[0], range[1] - 1);
  return { start, end: lineAt(counter, endOffset) };
}

function parsedRoot(text: string): { counter: LineCounter; map: YamlMap } | null {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (!isMap<ParsedNode, ParsedNode | null>(doc.contents)) return null;
  return { counter, map: doc.contents };
}

function scalarKey(node: ParsedNode | null | undefined): string | null {
  if (!isScalar(node)) return null;
  return typeof node.value === "string" ? node.value : null;
}

function pairByKey(map: YamlMap, key: string) {
  return map.items.find((pair) => scalarKey(pair.key) === key);
}

function keyPos(counter: LineCounter, map: YamlMap, key: string): KeyPos | undefined {
  const pair = pairByKey(map, key);
  const range = pair && isScalar(pair.key) ? pair.key.range : undefined;
  if (!range) return undefined;
  return { line: lineAt(counter, range[0]), column: columnAt(counter, range[0]) };
}

function childMap(map: YamlMap, key: string): YamlMap | null {
  const pair = pairByKey(map, key);
  return pair && isMap<ParsedNode, ParsedNode | null>(pair.value) ? pair.value : null;
}

function firstKeyPos(
  counter: LineCounter,
  map: YamlMap,
  keys: readonly string[],
): KeyPos | undefined {
  for (const key of keys) {
    const pos = keyPos(counter, map, key);
    if (pos) return pos;
  }
  return undefined;
}

function fieldPos(counter: LineCounter, map: YamlMap, field: string): KeyPos | undefined {
  if (field === "io.inputs" || field === "io.outputs") {
    const nested = field === "io.inputs" ? ["input", "inputs"] : ["output", "outputs"];
    const io = childMap(map, "io");
    if (io) {
      const pos = firstKeyPos(counter, io, nested);
      if (pos) return pos;
    }
    return keyPos(counter, map, "io");
  }
  const keys = FIELD_KEYS[field];
  if (!keys) return undefined;
  return firstKeyPos(counter, map, keys);
}

function pipelineStageEntries(
  counter: LineCounter,
  map: YamlMap,
  draft: DraftPackagePayload,
): StageEntry[] {
  const stages = pairByKey(map, "stages");
  if (!stages || !isSeq<ParsedNode>(stages.value)) return [];
  const entries: StageEntry[] = [];
  stages.value.items.forEach((item, index) => {
    if (!item?.range) return;
    const span = bounds(counter, item.range);
    const source = draft.pipeline.stages[index] ?? {};
    entries.push({
      stageId: stageIdFromRef(source, index),
      startLine: span.start,
      endLine: span.end,
      map: isMap<ParsedNode, ParsedNode | null>(item) ? item : null,
    });
  });
  return entries;
}

function parallelNames(ids: readonly string[]): string {
  if (ids.length === 2) return `${ids[0]} and ${ids[1]}`;
  return `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

export function editorFindingKey(finding: EditorFinding): string {
  const line = finding.line ?? "";
  const lineEnd = finding.lineEnd ?? "";
  return `${finding.code}\0${findingPathKey(finding.path)}\0${finding.message}\0${line}\0${lineEnd}`;
}

export function formatRelativeAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "just now";
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 2) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatEditorLocation(path: string, line?: number, lineEnd?: number): string {
  const base = basename(path);
  if (!base) return "—";
  const start = knownPositiveInt(line);
  if (!start) return base;
  const end = knownPositiveInt(lineEnd);
  if (end && end !== start) return `${base}:${start}\u2013${end}`;
  return `${base}:${start}`;
}

export function quickFixLabel(
  finding: EditorFinding,
  draft: DraftPackagePayload,
): string | undefined {
  const focus = focusEditorFinding(asValidationFinding(finding), draft);
  if (focus.kind !== "stage") return undefined;
  return `Go to ${focus.field} in ${focus.stageId}`;
}

export function editorInfoFindings(
  draft: DraftPackagePayload,
  pipelinePath: string,
): EditorFinding[] {
  const text = draftFileYaml(draft, pipelinePath, pipelinePath);
  const parsed = text ? parsedRoot(text) : null;
  const entries = parsed ? pipelineStageEntries(parsed.counter, parsed.map, draft) : [];
  const findings: EditorFinding[] = [];

  for (const id of stageIds(draft)) {
    const targets = needsTargets(stageRefFor(draft, id)?.needs);
    if (targets.length < 2) continue;
    const tail = targets.length > 2 ? `all ${targets.length} finish` : "both finish";
    const message = `${id} needs [${targets.join(", ")}]: ${id} runs only after ${tail}`;
    const entry = entries.find((row) => row.stageId === id);
    const needs = entry?.map && parsed ? keyPos(parsed.counter, entry.map, "needs") : undefined;
    const finding: EditorFinding = {
      severity: "info",
      code: "graph/needs",
      path: pipelinePath,
      message,
      category: "graph",
      stageId: id,
    };
    if (needs) finding.line = needs.line;
    findings.push(finding);
  }

  for (const layer of buildEditorLiveGraph(draft).layers) {
    const ids = layer.filter((node) => !node.loop).map((node) => node.stageId);
    if (ids.length < 2) continue;
    const message = `${parallelNames(ids)} run in parallel and hold ${ids.length} agent slots at once`;
    const involved = entries.filter((entry) => ids.includes(entry.stageId));
    const finding: EditorFinding = {
      severity: "info",
      code: "graph/parallel",
      path: pipelinePath,
      message,
      category: "graph",
    };
    if (involved.length > 0) {
      finding.line = Math.min(...involved.map((entry) => entry.startLine));
      finding.lineEnd = Math.max(...involved.map((entry) => entry.endLine));
    }
    findings.push(finding);
  }

  return findings;
}

export function resolveFindingLine(
  draft: DraftPackagePayload,
  pipelinePath: string,
  finding: EditorFinding,
): ResolvedFindingLine {
  const path = finding.path;
  const backendLine = knownPositiveInt(finding.line);
  if (backendLine) {
    const lineEnd = knownPositiveInt(finding.lineEnd);
    const column = knownPositiveInt(finding.column);
    return {
      path,
      line: backendLine,
      ...(lineEnd ? { lineEnd } : {}),
      ...(column ? { column } : {}),
    };
  }

  const text = draftFileYaml(draft, path, pipelinePath);
  const parsed = text ? parsedRoot(text) : null;
  if (!parsed) return { path };

  const focus = focusEditorFinding(asValidationFinding(finding), draft);
  const stageId = focus.kind === "stage" ? focus.stageId : finding.stageId;
  const field = focus.kind === "stage" ? focus.field : undefined;

  if (isPipelineYaml(path, pipelinePath)) {
    if (!stageId) return { path };
    const entry = pipelineStageEntries(parsed.counter, parsed.map, draft).find(
      (row) => row.stageId === stageId,
    );
    if (!entry) return { path };
    if (field && field !== "general" && entry.map) {
      const pos = fieldPos(parsed.counter, entry.map, field);
      if (pos) return { path, line: pos.line, column: pos.column };
    }
    return { path, line: entry.startLine };
  }

  if (field && field !== "general") {
    const pos = fieldPos(parsed.counter, parsed.map, field);
    if (pos) return { path, line: pos.line, column: pos.column };
  }
  const idPos = keyPos(parsed.counter, parsed.map, "id");
  if (idPos) return { path, line: idPos.line, column: idPos.column };
  return { path };
}
