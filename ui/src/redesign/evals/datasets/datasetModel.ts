import type {
  EvalCaseInput,
  EvalCaseOp,
  EvalDatasetCase,
  EvalDatasetDetail,
  EvalDatasetListItem,
  EvalDatasetQuery,
} from "../../../api/evalTypes";

export const PAGE_SIZE = 25;
export const MAX_EXPECTED_COLUMNS = 2;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DATASET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const SAMPLE_DATASET_ID = "sample-review-diffs";
export const FILE_CHANGED_MESSAGE = "The file changed on disk. Reload.";

export type DatasetTab = "all" | "invalid" | "tagged";
export type DatasetView = "table" | "jsonl";

export type DatasetTabDef = { id: DatasetTab; label: string; count: number };

export function datasetTabs(detail: Pick<EvalDatasetDetail, "cases_total" | "invalid_total" | "tagged_total">): DatasetTabDef[] {
  return [
    { id: "all", label: "All", count: detail.cases_total },
    { id: "invalid", label: "Invalid", count: detail.invalid_total },
    { id: "tagged", label: "Tagged", count: detail.tagged_total },
  ];
}

export function filterForTab(tab: DatasetTab): "all" | "invalid" | "tagged" {
  return tab;
}

export function datasetQuery(opts: {
  tab: DatasetTab;
  q: string;
  page: number;
  evalId?: string | undefined;
  projectRoot?: string | undefined;
}): EvalDatasetQuery {
  const q = opts.q.trim();
  return {
    offset: Math.max(0, opts.page) * PAGE_SIZE,
    limit: PAGE_SIZE,
    filter: filterForTab(opts.tab),
    ...(q !== "" ? { q } : {}),
    ...(opts.evalId ? { eval_id: opts.evalId } : {}),
    ...(opts.projectRoot ? { project_root: opts.projectRoot } : {}),
  };
}

export type PageInfo = {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  label: string;
};

export function pageInfo(page: number, total: number, size = PAGE_SIZE): PageInfo {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const from = total === 0 ? 0 : p * size + 1;
  const to = Math.min(total, (p + 1) * size);
  return {
    page: p,
    pages,
    from,
    to,
    total,
    hasPrev: p > 0,
    hasNext: p < pages - 1,
    label: total === 0 ? "No cases" : `Showing ${from} to ${to} of ${total}`,
  };
}

export type ExpectedColumns = { shown: string[]; more: number; scalar: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectedColumns(cases: EvalCaseInput[]): ExpectedColumns {
  const keys: string[] = [];
  let scalar = false;
  for (const c of cases) {
    if (c.expected === undefined || c.expected === null) continue;
    if (isRecord(c.expected)) {
      for (const key of Object.keys(c.expected)) if (!keys.includes(key)) keys.push(key);
    } else {
      scalar = true;
    }
  }
  if (keys.length === 0 && scalar) return { shown: [], more: 0, scalar: true };
  return { shown: keys.slice(0, MAX_EXPECTED_COLUMNS), more: Math.max(0, keys.length - MAX_EXPECTED_COLUMNS), scalar: false };
}

export type CellKey =
  | { kind: "input"; name: string }
  | { kind: "expected"; key: string | null }
  | { kind: "tags" };

export type ColumnDef = { id: string; label: string; cell: CellKey | null; check?: boolean };

export function datasetColumns(detail: Pick<EvalDatasetDetail, "input_fields" | "cases">): {
  columns: ColumnDef[];
  moreExpected: number;
} {
  const inputNames = detail.input_fields.map((f) => f.name);
  if (inputNames.length === 0) {
    for (const c of detail.cases) for (const k of Object.keys(c.input ?? {})) if (!inputNames.includes(k)) inputNames.push(k);
  }
  const columns: ColumnDef[] = [{ id: "#", label: "#", cell: null }];
  for (const name of inputNames) columns.push({ id: `input.${name}`, label: name, cell: { kind: "input", name } });
  const expected = expectedColumns(detail.cases);
  if (expected.scalar) columns.push({ id: "expected", label: "expected", cell: { kind: "expected", key: null } });
  for (const key of expected.shown) {
    columns.push({ id: `expected.${key}`, label: `expected.${key}`, cell: { kind: "expected", key } });
  }
  columns.push({ id: "tags", label: "Tags", cell: { kind: "tags" } });
  columns.push({ id: "check", label: "Input check", cell: null, check: true });
  return { columns, moreExpected: expected.more };
}

export type CheckLabel = { kind: "valid" | "invalid" | "none"; label: string; title?: string };

export function checkLabel(c: Pick<EvalDatasetCase, "input_check">): CheckLabel {
  const check = c.input_check;
  if (check === null || check === undefined) return { kind: "none", label: "" };
  if (check.valid) return { kind: "valid", label: "Valid" };
  const message = (check.message ?? "").trim();
  const match = /(?:^|[:\s])([A-Za-z0-9_.-]+) is (?:missing|required|empty)\b/.exec(message);
  const label = match?.[1] ? `Missing ${match[1]}` : message || "Invalid";
  return { kind: "invalid", label, ...(message !== "" ? { title: message } : {}) };
}

export function caseIsInvalid(c: Pick<EvalDatasetCase, "input_check">): boolean {
  return c.input_check?.valid === false;
}

export function firstInvalidReason(detail: Pick<EvalDatasetDetail, "cases" | "findings">): string | null {
  for (const c of detail.cases) {
    if (c.input_check?.valid === false && c.input_check.message) return stripCasePrefix(c.input_check.message);
  }
  const finding = detail.findings.find((f) => f.code === "dataset.input_mismatch");
  return finding ? stripCasePrefix(finding.message) : null;
}

function stripCasePrefix(message: string): string {
  return message.replace(/^case\s+\S+?[:\s-]+\s*/i, "").replace(/\.$/, "");
}

export function invalidBanner(
  detail: Pick<EvalDatasetDetail, "cases_total" | "invalid_total" | "cases" | "findings">,
): { title: string; reason: string | null; tail: string } | null {
  if (detail.invalid_total <= 0) return null;
  return {
    title: `${detail.invalid_total} of ${detail.cases_total} cases do not match the stage's input.`,
    reason: firstInvalidReason(detail),
    tail: "They are skipped in runs until fixed.",
  };
}

export function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function isJsonValue(value: unknown): boolean {
  return value !== undefined && typeof value !== "string";
}

export type ParsedCell = { ok: true; value: unknown; omit?: boolean } | { ok: false; error: string };

/** Text from the editor to a stored value. `current` decides string versus JSON (the schema type is not in the API). */
export function parseCellText(text: string, current: unknown, required = false): ParsedCell {
  if (isJsonValue(current) && current !== null) {
    const trimmed = text.trim();
    if (trimmed === "") return { ok: true, value: undefined, omit: true };
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch {
      return { ok: false, error: "Not valid JSON" };
    }
  }
  if (text === "" && !required) return { ok: true, value: undefined, omit: true };
  return { ok: true, value: text };
}

export function parseTagsText(text: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  const tags = text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const unique = [...new Set(tags)];
  if (unique.length > 10) return { ok: false, error: "At most 10 tags" };
  const bad = unique.find((t) => !TAG_PATTERN.test(t));
  if (bad) return { ok: false, error: `"${bad}" is not a valid tag (lowercase letters, digits, dashes)` };
  return { ok: true, tags: unique };
}

export function stripCheck(c: EvalDatasetCase): EvalCaseInput & { id: string } {
  const { input_check: _ignored, ...rest } = c;
  void _ignored;
  return rest;
}

export function currentCellValue(c: EvalCaseInput, cell: CellKey): unknown {
  if (cell.kind === "input") return c.input?.[cell.name];
  if (cell.kind === "tags") return c.tags;
  if (cell.key === null) return c.expected;
  return isRecord(c.expected) ? c.expected[cell.key] : undefined;
}

export type CellEditResult = { ok: true; op: EvalCaseOp | null } | { ok: false; error: string };

export function buildCellEditOp(
  c: EvalDatasetCase,
  cell: CellKey,
  text: string,
  required: boolean,
): CellEditResult {
  if (cell.kind === "tags") {
    const parsed = parseTagsText(text);
    if (!parsed.ok) return parsed;
    const before = c.tags ?? [];
    if (before.length === parsed.tags.length && before.every((t, i) => t === parsed.tags[i])) return { ok: true, op: null };
    return { ok: true, op: { op: "set_tags", id: c.id, tags: parsed.tags } };
  }
  const current = currentCellValue(c, cell);
  if (text === cellText(current)) return { ok: true, op: null };
  const parsed = parseCellText(text, current, cell.kind === "input" && required);
  if (!parsed.ok) return parsed;
  const next = stripCheck(c);
  if (cell.kind === "input") {
    const input = { ...next.input };
    if (parsed.omit) delete input[cell.name];
    else input[cell.name] = parsed.value;
    next.input = input;
  } else if (cell.key === null) {
    if (parsed.omit) delete next.expected;
    else next.expected = parsed.value;
  } else {
    const expected = isRecord(next.expected) ? { ...next.expected } : {};
    if (parsed.omit) delete expected[cell.key];
    else expected[cell.key] = parsed.value;
    next.expected = expected;
  }
  return { ok: true, op: { op: "update", id: c.id, case: next } };
}

export function buildDeleteOp(id: string): EvalCaseOp {
  return { op: "delete", id };
}

export type SaveState = { status: "idle" | "saving" | "saved" | "conflict" | "error"; message?: string };
export type SaveEvent =
  | { type: "start" }
  | { type: "success" }
  | { type: "conflict" }
  | { type: "fail"; message: string }
  | { type: "reset" };

export const INITIAL_SAVE: SaveState = { status: "idle" };

export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case "start":
      return state.status === "conflict" ? state : { status: "saving" };
    case "success":
      return state.status === "conflict" ? state : { status: "saved" };
    case "conflict":
      return { status: "conflict", message: FILE_CHANGED_MESSAGE };
    case "fail":
      return { status: "error", message: event.message };
    case "reset":
      return INITIAL_SAVE;
  }
}

export function saveLabel(state: SaveState): string {
  switch (state.status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "conflict":
    case "error":
      return state.message ?? "";
    default:
      return "";
  }
}

export function footerNote(path: string, editable: boolean): string {
  return editable
    ? `Changes save to ${path} when you leave a cell. Commit the file to keep it in git.`
    : `${path} is read-only here. Convert it to JSONL to edit cases.`;
}

export function nextCaseId(ids: readonly string[]): string {
  let max = 0;
  for (const id of ids) {
    const m = /^c(\d+)$/.exec(id);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  return `c${String(n).padStart(3, "0")}`;
}

export const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type AddCaseForm = {
  id: string;
  title: string;
  inputs: Record<string, string>;
  /** Used when the stage's input fields are unknown: the whole input as a JSON object. */
  inputJson?: string;
  expected: string;
  tags: string;
};

export type AddCaseResult =
  | { ok: true; case: EvalCaseInput & { id: string } }
  | { ok: false; errors: Record<string, string> };

/** `jsonFields` lists input names edited as JSON text (non-string schema properties). */
export function buildAddCase(
  form: AddCaseForm,
  opts: { existingIds: readonly string[]; jsonFields?: readonly string[] },
): AddCaseResult {
  const errors: Record<string, string> = {};
  const id = form.id.trim();
  if (!CASE_ID_PATTERN.test(id)) errors.id = "Use letters, digits, . _ - (max 64)";
  else if (opts.existingIds.includes(id)) errors.id = "That id is already used";
  const title = form.title.trim();
  if (title.length > 120) errors.title = "At most 120 characters";
  const input: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(form.inputs)) {
    if (text === "") continue;
    if (opts.jsonFields?.includes(name)) {
      try {
        input[name] = JSON.parse(text) as unknown;
      } catch {
        errors[`input.${name}`] = "Not valid JSON";
      }
    } else {
      input[name] = text;
    }
  }
  if (form.inputJson !== undefined) {
    try {
      const parsed = JSON.parse(form.inputJson) as unknown;
      if (isRecord(parsed)) Object.assign(input, parsed);
      else errors.inputJson = "Input must be a JSON object";
    } catch {
      errors.inputJson = "Not valid JSON";
    }
  }
  let expected: unknown;
  if (form.expected.trim() !== "") {
    try {
      expected = JSON.parse(form.expected) as unknown;
    } catch {
      errors.expected = "Not valid JSON";
    }
  }
  const tags = parseTagsText(form.tags);
  if (!tags.ok) errors.tags = tags.error;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    case: {
      id,
      input,
      ...(title !== "" ? { title } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(tags.ok && tags.tags.length > 0 ? { tags: tags.tags } : {}),
    },
  };
}

export function serializeJsonl(cases: EvalDatasetCase[]): string {
  return cases.map((c) => JSON.stringify(stripCheck(c))).join("\n");
}

export function railMeta(item: Pick<EvalDatasetListItem, "id" | "cases" | "used_by">): {
  meta: string;
  sample: boolean;
  note: string | null;
} {
  const n = item.used_by.length;
  const sample = item.id === SAMPLE_DATASET_ID;
  return {
    sample,
    note: sample ? "ships with Stageflow" : null,
    meta: sample
      ? `${item.cases} cases`
      : `${item.cases} ${item.cases === 1 ? "case" : "cases"} · used by ${n} ${n === 1 ? "eval" : "evals"}`,
  };
}

export function datasetSubtitle(opts: {
  cases: number;
  stage: string | null;
  usedBy: string[];
  path: string;
}): string {
  const parts = [`${opts.cases} ${opts.cases === 1 ? "case" : "cases"}${opts.stage ? ` for the ${opts.stage} stage` : ""}`];
  if (opts.usedBy.length > 0) parts.push(`used by ${opts.usedBy.join(", ")}`);
  parts.push(opts.path);
  return parts.join(" · ");
}

export function readOnlyBanner(format: string | null): string | null {
  return format === "json" || format === "csv" ? format : null;
}

export function projectRootOf(item: unknown): string | undefined {
  if (typeof item === "object" && item !== null && "project_root" in item) {
    const v = (item as { project_root?: unknown }).project_root;
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

export function datasetSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function validateDatasetName(name: string, existing: readonly string[]): string | null {
  if (name === "") return "Name is required";
  if (!DATASET_NAME_PATTERN.test(name)) return "Use lowercase letters, digits and dashes (max 63)";
  if (existing.includes(name)) return "A dataset with this name already exists";
  return null;
}
