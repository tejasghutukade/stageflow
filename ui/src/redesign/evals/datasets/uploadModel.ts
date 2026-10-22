import type {
  EvalConversationMode,
  EvalCaseInput,
  EvalCreateDatasetInput,
  EvalDatasetFormat,
  EvalDatasetPreview,
  EvalDatasetPreviewInput,
  EvalDatasetTarget,
  EvalUploadMapping,
} from "../../../api/evalTypes";

import { scenarioProblem } from "./scenarioModel";

export type UploadFieldRole = "input" | "expected" | "meta";
export type UploadFieldKind = "required" | "optional" | "reference";

export type UploadField = {
  /** Mapping key, `input.<name>` or `expected.<name>`. */
  key: string;
  name: string;
  role: UploadFieldRole;
  kind: UploadFieldKind;
  /** The row offers a split character (lists such as facts and tools). */
  splittable?: boolean;
};

export type FieldChoice = { column: string | null; split?: string };
export type MappingState = Record<string, FieldChoice>;

export const SPLIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "no split" },
  { value: ";", label: "split on ;" },
  { value: ",", label: "split on ," },
  { value: "|", label: "split on |" },
];

export const DELIMITERS: Array<{ value: string; label: string }> = [
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
];

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const PREVIEW_ROWS = 5;

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(?:input|expected)\./, "")
    .replace(/[\s_-]+/g, "_");
}

export function stageFields(
  inputFields: ReadonlyArray<{ name: string; required: boolean }>,
  expectedFields: readonly string[] = [],
): UploadField[] {
  const fields: UploadField[] = inputFields.map((f) => ({
    key: `input.${f.name}`,
    name: f.name,
    role: "input",
    kind: f.required ? "required" : "optional",
  }));
  for (const name of expectedFields) {
    fields.push({ key: `expected.${name}`, name: `expected.${name}`, role: "expected", kind: "reference" });
  }
  return fields;
}

export const SCRIPT_NOTICE = "Scripts and tool mocks need a JSON or JSONL file.";

/** The ten scenario fields a CSV column can fill. `script` and `tool_mocks` are JSON-only and not offered. */
export function agentFields(): UploadField[] {
  const input = (name: string, splittable = false): UploadField => ({
    key: `input.${name}`,
    name,
    role: "input",
    kind: "optional",
    ...(splittable ? { splittable: true } : {}),
  });
  const expected = (name: string, splittable = false): UploadField => ({
    key: `expected.${name}`,
    name: `expected.${name}`,
    role: "expected",
    kind: "reference",
    ...(splittable ? { splittable: true } : {}),
  });
  return [
    input("opening"),
    input("goal"),
    input("persona"),
    input("mode"),
    input("facts", true),
    expected("outcome"),
    expected("tools", true),
    expected("forbidden_tools", true),
    { key: "title", name: "title", role: "meta", kind: "optional" },
    { key: "tags", name: "tags", role: "meta", kind: "optional", splittable: true },
  ];
}

export function fieldSplits(field: UploadField): boolean {
  return field.role === "expected" || field.splittable === true;
}

/** Without a stage: one optional input field per column ("Pick fields to import"). */
export function freeFields(columns: readonly string[]): UploadField[] {
  return columns.map((c) => ({ key: `input.${c}`, name: c, role: "input", kind: "optional" }));
}

function fieldBaseName(field: UploadField): string {
  return field.role === "expected" ? field.name.replace(/^expected\./, "") : field.name;
}

/** Same-named columns only: `diff_text` does not match `diff`. A column serves one field. */
export function autoMatch(fields: readonly UploadField[], columns: readonly string[]): MappingState {
  const used = new Set<string>();
  const state: MappingState = {};
  for (const field of fields) {
    const want = normalizeName(fieldBaseName(field));
    const column = columns.find((c) => !used.has(c) && normalizeName(c) === want) ?? null;
    if (column !== null) used.add(column);
    state[field.key] = { column };
  }
  return state;
}

export function setColumn(state: MappingState, key: string, column: string | null): MappingState {
  const prev = state[key];
  return { ...state, [key]: { column, ...(prev?.split ? { split: prev.split } : {}) } };
}

export function setSplit(state: MappingState, key: string, split: string): MappingState {
  const prev = state[key] ?? { column: null };
  const next: FieldChoice = { column: prev.column };
  if (split !== "") next.split = split;
  return { ...state, [key]: next };
}

export function buildMapping(fields: readonly UploadField[], state: MappingState): EvalUploadMapping {
  const mapping: EvalUploadMapping = {};
  for (const field of fields) {
    const choice = state[field.key];
    if (!choice || choice.column === null) {
      mapping[field.key] = null;
    } else {
      mapping[field.key] = {
        column: choice.column,
        ...(fieldSplits(field) && choice.split ? { split: choice.split } : {}),
      };
    }
  }
  return mapping;
}

export function missingRequired(fields: readonly UploadField[], state: MappingState): string[] {
  return fields.filter((f) => f.kind === "required" && !state[f.key]?.column).map((f) => f.name);
}

export function formatFromFileName(name: string): EvalDatasetFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv";
  return null;
}

export const UPLOAD_EXT_ERROR = "Use a .jsonl, .json or .csv file.";
export const UPLOAD_SIZE_ERROR = "That file is over the 50 MB limit.";
export const DROP_LABEL = "Drop file to upload";

/** Accept by extension and size; the error text is what the dialog shows. */
export function checkUploadFile(file: { name: string; size: number }): { format: EvalDatasetFormat } | { error: string } {
  const format = formatFromFileName(file.name);
  if (!format) return { error: UPLOAD_EXT_ERROR };
  if (file.size > MAX_UPLOAD_BYTES) return { error: UPLOAD_SIZE_ERROR };
  return { format };
}

/** Only drags that carry files light up the zone (text or link drags are ignored). */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes("Files");
}

export function firstFile<T>(files: ArrayLike<T> | null | undefined): T | undefined {
  return files && files.length > 0 ? files[0] : undefined;
}

/** Drag depth counter: enter/leave fire for every child, so highlight while the count is above zero. */
export function dragDepth(depth: number, event: "enter" | "leave" | "reset"): number {
  if (event === "reset") return 0;
  return Math.max(0, depth + (event === "enter" ? 1 : -1));
}

export function defaultDelimiter(name: string): string {
  return name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}

/** Pasted text: JSONL if every non-blank line starts with `{`, else CSV. */
export function detectPastedFormat(text: string): EvalDatasetFormat | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  return lines.every((l) => l.trimStart().startsWith("{")) ? "jsonl" : "csv";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function rowsFoundText(n: number): string {
  return `${n} ${n === 1 ? "row" : "rows"} found`;
}

export function buildPreviewRequest(opts: {
  format: EvalDatasetFormat;
  content: string;
  delimiter?: string;
  mapping?: EvalUploadMapping;
  target?: EvalDatasetTarget;
  projectRoot?: string | undefined;
  /** Agent targets: the eval whose `conversation.mode` the rows are checked against. */
  evalId?: string | undefined;
}): EvalDatasetPreviewInput {
  return {
    format: opts.format,
    content: opts.content,
    ...(opts.format === "csv" && opts.delimiter && opts.delimiter !== "," ? { delimiter: opts.delimiter } : {}),
    ...(opts.mapping ? { mapping: opts.mapping } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.projectRoot ? { project_root: opts.projectRoot } : {}),
    ...(opts.evalId ? { eval_id: opts.evalId } : {}),
  };
}

export function hasTarget(target: EvalDatasetTarget | undefined): boolean {
  return !!target && (!!target.stage_id || !!target.file || !!target.agent_id);
}

export function isAgentUpload(target: EvalDatasetTarget | undefined): boolean {
  return !!target?.agent_id;
}

/** Agent previews show the opening (or first script message) and the title or goal. */
export function agentPreviewRows(preview: Pick<EvalDatasetPreview, "rows"> | null, limit = PREVIEW_ROWS): PreviewRowView[] {
  if (!preview) return [];
  return preview.rows.slice(0, limit).map((row) => {
    const input = (row.case.input ?? {}) as Record<string, unknown>;
    const script = Array.isArray(input.script) ? input.script : [];
    const text = oneLine(input.opening ?? script[0] ?? "");
    const secondary = oneLine(row.case.title ?? input.goal ?? "");
    return {
      index: row.index,
      text,
      secondary: row.status === "skipped" && secondary === "" ? "(empty)" : secondary,
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
    };
  });
}

export function summarize(preview: Pick<EvalDatasetPreview, "rows" | "counts"> | null): string {
  if (!preview) return "";
  const { ready, skipped } = preview.counts;
  const head = ready === 0 ? "No cases ready" : `${ready} ${ready === 1 ? "case" : "cases"} ready`;
  if (skipped === 0) return head;
  const reasons: string[] = [];
  for (const row of preview.rows) {
    if (row.status === "skipped" && row.reason && !reasons.includes(row.reason)) reasons.push(row.reason);
  }
  const why = reasons.length === 1 ? ` because ${reasons[0]}` : reasons.length > 1 ? ` (${reasons.join(", ")})` : "";
  return `${head} · ${skipped} skipped${why}`;
}

export type PreviewRowView = { index: number; text: string; secondary: string; status: "ready" | "skipped"; reason?: string };

function oneLine(value: unknown): string {
  if (value === undefined || value === null) return "";
  return (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ").trim();
}

export function previewRows(
  preview: Pick<EvalDatasetPreview, "rows"> | null,
  inputNames: readonly string[],
  limit = PREVIEW_ROWS,
): PreviewRowView[] {
  if (!preview) return [];
  return preview.rows.slice(0, limit).map((row) => {
    const input = row.case.input ?? {};
    const names = inputNames.length > 0 ? inputNames : Object.keys(input);
    const first = names[0];
    const second = names[1];
    const text = first ? oneLine(input[first]) : "";
    const secondary = second ? oneLine(input[second]) : oneLine(row.case.title);
    return {
      index: row.index,
      text,
      secondary: row.status === "skipped" && secondary === "" ? "(empty)" : secondary,
      status: row.status,
      ...(row.reason ? { reason: row.reason } : {}),
    };
  });
}

export type UploadMode = "append" | "replace";

/** What the dialog hands to `onConfirm`. The caller decides which endpoint to use. */
export type UploadConfirm = {
  mode: UploadMode;
  /** Ready rows only. Ids are kept only when they cannot collide (see `casesForImport`). */
  cases: EvalCaseInput[];
  ready: number;
  skipped: number;
  fileName: string;
  format: EvalDatasetFormat;
  /** Agent uploads: every parsed row, so the caller can check them against its own conversation mode. */
  candidates?: EvalCaseInput[];
};

export const SCRIPTED_SWITCH_LABEL = "Scripted conversations";
export const SCRIPTED_SWITCH_NOTE = "Scenarios without a mode are checked as scripted: each needs a script, which a JSON or JSONL file carries.";

/** Agent previews: the server checks rows against the eval's mode (simulated for a new dataset); this checks them against the mode the caller means. */
export function recheckForMode(preview: EvalDatasetPreview, mode: EvalConversationMode): EvalDatasetPreview {
  const rows = preview.rows.map((row) => {
    const problem = scenarioProblem(row.case, mode);
    const { reason: _reason, ...rest } = row;
    void _reason;
    return problem === null ? { ...rest, status: "ready" as const } : { ...rest, status: "skipped" as const, reason: problem };
  });
  const ready = rows.filter((r) => r.status === "ready").length;
  return { ...preview, rows, counts: { ready, skipped: rows.length - ready } };
}

export function readyCases(preview: Pick<EvalDatasetPreview, "rows">): Array<EvalCaseInput & { id: string }> {
  return preview.rows.filter((r) => r.status === "ready").map((r) => r.case);
}

/** CSV and pasted-CSV rows carry preview ids that only mean "position": the server numbers them. */
export function casesForImport(
  cases: ReadonlyArray<EvalCaseInput & { id: string }>,
  opts: { format: EvalDatasetFormat; mode: UploadMode; existingIds: readonly string[] },
): EvalCaseInput[] {
  const taken = new Set(opts.mode === "append" ? opts.existingIds : []);
  return cases.map((c) => {
    if (opts.format === "csv" || taken.has(c.id)) {
      const { id: _id, ...rest } = c;
      void _id;
      return rest;
    }
    return c;
  });
}

export function confirmLabel(ready: number, mode: UploadMode, existing: number): string {
  if (ready === 0) return "Nothing to add";
  if (mode === "replace" && existing > 0) return `Replace with ${ready} ${ready === 1 ? "case" : "cases"}`;
  return `Add ${ready} ${ready === 1 ? "case" : "cases"}`;
}

export function modeLabels(existing: number): { append: string; replace: string } {
  return { append: `Add to the ${existing} cases already here`, replace: "Replace all cases" };
}

export function toCreateDatasetInput(
  req: UploadConfirm,
  dest: { name: string; projectRoot?: string } | { datasetId: string; baseHash: string; projectRoot?: string },
): EvalCreateDatasetInput {
  const root = dest.projectRoot ? { project_root: dest.projectRoot } : {};
  if ("name" in dest) return { ...root, name: dest.name, cases: req.cases };
  return { ...root, dataset_id: dest.datasetId, mode: req.mode, cases: req.cases, base_hash: dest.baseHash };
}

export function canConfirm(preview: Pick<EvalDatasetPreview, "counts"> | null, busy: boolean): boolean {
  return !busy && preview !== null && preview.counts.ready > 0;
}

export type ExtraChoice = { enabled: boolean; key: string; split: string };
/** Reference-data rows, keyed by CSV column. */
export type ExtraState = Record<string, ExtraChoice>;

export const EXTRAS_TITLE = "Reference data (optional)";

/** `Expected Category` and `expected_category` both become `category`. */
export function defaultExpectedKey(column: string): string {
  const flat = column.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const stripped = flat.replace(/^expected[._]/, "");
  return stripped !== "" ? stripped : flat;
}

/** Suggest `;` when most non-empty cells contain one. */
export function suggestSplit(values: readonly string[]): string {
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return "";
  const withSemi = filled.filter((v) => v.includes(";")).length;
  return withSemi * 2 > filled.length ? ";" : "";
}

/** Raw cells per column, from preview rows that carry the CSV unmapped (every column as `input.<column>`). */
export function cellsByColumn(
  rows: ReadonlyArray<{ case: { input?: Record<string, unknown> } }>,
  columns: readonly string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of columns) {
    out[c] = rows.map((r) => r.case.input?.[c]).filter((v): v is string => typeof v === "string");
  }
  return out;
}

/** Columns already named `expected_*` / `expected.*` start checked; the rest are opt-in. */
export function initExtras(columns: readonly string[], cells: Record<string, readonly string[]> = {}): ExtraState {
  const state: ExtraState = {};
  for (const column of columns) {
    state[column] = {
      enabled: /^expected[._]/i.test(column.trim()),
      key: defaultExpectedKey(column),
      split: suggestSplit(cells[column] ?? []),
    };
  }
  return state;
}

/** Columns not taken by an input field or a grader-driven `expected.<name>` row. */
export function extraColumns(
  columns: readonly string[],
  fields: readonly UploadField[],
  state: MappingState,
): string[] {
  const used = new Set<string>();
  for (const f of fields) {
    const col = state[f.key]?.column;
    if (col) used.add(col);
  }
  return columns.filter((c) => !used.has(c));
}

export function patchExtra(state: ExtraState, column: string, patch: Partial<ExtraChoice>): ExtraState {
  const prev = state[column] ?? { enabled: false, key: defaultExpectedKey(column), split: "" };
  return { ...state, [column]: { ...prev, ...patch } };
}

function extraKey(choice: ExtraChoice): string {
  return choice.key.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^expected\./, "");
}

/** Empty keys, keys used twice, or keys clashing with a grader field do not import: grader rows win, then the first row in column order. */
export function extraConflicts(
  extras: ExtraState,
  available: readonly string[],
  takenKeys: readonly string[] = [],
): Set<string> {
  const seen = new Set(takenKeys);
  const bad = new Set<string>();
  for (const column of available) {
    const choice = extras[column];
    if (!choice?.enabled) continue;
    const key = extraKey(choice);
    if (key === "" || seen.has(key)) bad.add(column);
    else seen.add(key);
  }
  return bad;
}

export function buildExtraMapping(
  extras: ExtraState,
  available: readonly string[],
  takenKeys: readonly string[] = [],
): EvalUploadMapping {
  const bad = extraConflicts(extras, available, takenKeys);
  const mapping: EvalUploadMapping = {};
  for (const column of available) {
    const choice = extras[column];
    if (!choice?.enabled || bad.has(column)) continue;
    mapping[`expected.${extraKey(choice)}`] = { column, ...(choice.split ? { split: choice.split } : {}) };
  }
  return mapping;
}

/** Field rows plus the optional reference-data rows (stage-aware mode only; pass `extras` null otherwise). */
export function buildFullMapping(
  fields: readonly UploadField[],
  state: MappingState,
  extras: ExtraState | null,
  columns: readonly string[],
): EvalUploadMapping {
  const base = buildMapping(fields, state);
  if (!extras) return base;
  const taken = fields.filter((f) => f.role === "expected").map((f) => fieldBaseName(f));
  return { ...buildExtraMapping(extras, extraColumns(columns, fields, state), taken), ...base };
}

export const FREE_MODE_HINT = "Pick fields to import";
export const FREE_MODE_NOTE = "Without a stage, each column you pick becomes an input field.";
