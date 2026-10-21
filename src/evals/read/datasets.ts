import path from "node:path";
import { isInsideProjectRoot } from "../../config/catalogRelativePath.js";
import { parseCsv, CsvParseError } from "../../config/csv.js";
import { checkDatasetAgainstStage } from "../../config/datasetStageCheck.js";
import {
  applyUploadMapping,
  formatId,
  nextIdNumber,
  type UploadMapping,
  type UploadPreviewRow,
} from "../../config/datasetImport.js";
import type { DatasetCase, DatasetFormat, DatasetLoadResult } from "../../config/datasetTypes.js";
import { DATASET_LIMITS } from "../../config/loadDataset.js";
import { resolveEvalTarget } from "../../config/resolveEvalTarget.js";
import type { ValidationFinding } from "../../config/validateCatalog.js";
import type { EvalFile } from "../types.js";

export type InputField = { name: string; required: boolean };

export type DatasetTarget = { pipeline_path?: string; stage_id?: string; file?: string };

export type DatasetListItem = {
  project_root: string;
  id: string;
  path: string;
  format: DatasetFormat | null;
  cases: number;
  hash: string;
  editable: boolean;
  used_by: string[];
  findings_count: number;
};

export type DatasetQuery = {
  offset: number;
  limit: number;
  tag?: string;
  q?: string;
  filter: "all" | "invalid" | "tagged";
};

export type DatasetDetail = {
  id: string;
  path: string;
  format: DatasetFormat | null;
  hash: string;
  editable: boolean;
  cases_total: number;
  invalid_total: number;
  tagged_total: number;
  matched_total: number;
  tags: Record<string, number>;
  input_fields: InputField[];
  cases: Array<DatasetCase & { input_check: { valid: boolean; message?: string } | null }>;
  findings: ValidationFinding[];
  used_by: string[];
};

export function inputFieldsOf(schema: unknown): InputField[] {
  if (typeof schema !== "object" || schema === null) return [];
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (typeof properties !== "object" || properties === null) return [];
  const requiredSet = new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : []);
  return Object.keys(properties).map((name) => ({ name, required: requiredSet.has(name) }));
}

export type ResolvedDatasetTarget = { inputSchema: unknown; stageId: string | undefined; pipelineAbsPath: string | undefined };

export async function resolveDatasetTarget(
  projectRoot: string,
  target: DatasetTarget,
): Promise<{ ok: true; value: ResolvedDatasetTarget } | { ok: false; message: string }> {
  const kindFile = target.file !== undefined;
  const kindPipeline = target.pipeline_path !== undefined && target.stage_id !== undefined;
  if (kindFile === kindPipeline) {
    return { ok: false, message: "target needs either file or pipeline_path with stage_id" };
  }
  const given = (kindFile ? target.file : target.pipeline_path) as string;
  if (path.isAbsolute(given) || !isInsideProjectRoot(projectRoot, path.resolve(projectRoot, given))) {
    return { ok: false, message: "target path must be relative and inside the project" };
  }
  const evalAbs = path.join(projectRoot, "target-lookup.eval.yaml");
  const file: EvalFile = {
    version: 1,
    id: "target-lookup",
    target: kindFile
      ? { kind: "stage", file: target.file as string }
      : { kind: "stage", pipeline: target.pipeline_path as string, stage: target.stage_id as string },
    dataset: "target-lookup.dataset.jsonl",
    graders: [],
  };
  const outcome = await resolveEvalTarget(file, evalAbs, projectRoot);
  if (!outcome.ok) return { ok: false, message: outcome.issues[0]?.message ?? "target does not resolve" };
  const { inputSchema, stageId, pipelinePath } = outcome.value;
  return { ok: true, value: { inputSchema, stageId, pipelineAbsPath: pipelinePath } };
}

export function buildDatasetDetail(input: {
  id: string;
  loaded: DatasetLoadResult;
  inputSchema: unknown;
  hasEval: boolean;
  usedBy: string[];
  query: DatasetQuery;
}): DatasetDetail {
  const { loaded, query } = input;
  const checks = input.hasEval
    ? new Map(checkDatasetAgainstStage(loaded.cases, input.inputSchema).map((c) => [c.caseId, c]))
    : undefined;
  const tags: Record<string, number> = {};
  let tagged = 0;
  let invalid = 0;
  for (const c of loaded.cases) {
    if ((c.tags ?? []).length > 0) tagged += 1;
    for (const tag of c.tags ?? []) tags[tag] = (tags[tag] ?? 0) + 1;
    if (checks?.get(c.id)?.valid === false) invalid += 1;
  }
  const q = query.q?.trim().toLowerCase();
  const matched = loaded.cases.filter((c) => {
    const check = checks?.get(c.id);
    if (query.filter === "invalid" && check?.valid !== false) return false;
    if (query.filter === "tagged" && (c.tags ?? []).length === 0) return false;
    if (query.tag !== undefined && !(c.tags ?? []).includes(query.tag)) return false;
    if (q === undefined || q === "") return true;
    return `${c.id}\n${c.title ?? ""}\n${JSON.stringify(c.input)}`.toLowerCase().includes(q);
  });
  const page = matched.slice(query.offset, query.offset + query.limit);
  return {
    id: input.id,
    path: loaded.relPath,
    format: loaded.format ?? null,
    hash: loaded.contentHash,
    editable: loaded.format === "jsonl",
    cases_total: loaded.cases.length,
    invalid_total: invalid,
    tagged_total: tagged,
    matched_total: matched.length,
    tags,
    input_fields: inputFieldsOf(input.inputSchema),
    cases: page.map((c) => {
      const check = checks?.get(c.id);
      return {
        ...c,
        input_check: check === undefined ? null : { valid: check.valid, ...(check.message !== undefined ? { message: check.message } : {}) },
      };
    }),
    findings: loaded.findings,
    used_by: input.usedBy,
  };
}

const CASE_KEYS = new Set(["id", "input", "title", "expected", "tags", "goal", "metadata"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PreviewInput = {
  format: DatasetFormat;
  content: string;
  delimiter?: string;
  mapping?: UploadMapping;
  inputSchema?: unknown;
  existingIds?: readonly string[];
};

export type PreviewResult = {
  columns?: string[];
  rows: UploadPreviewRow[];
  findings: ValidationFinding[];
  counts: { ready: number; skipped: number };
};

function uploadFinding(code: string, message: string, line?: number): ValidationFinding {
  return {
    severity: "error",
    code,
    path: "",
    message,
    category: "dataset",
    ...(line !== undefined ? { line } : {}),
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjectRows(
  format: "jsonl" | "json",
  content: string,
  findings: ValidationFinding[],
): Array<Record<string, unknown>> {
  if (format === "jsonl") {
    const rows: Array<Record<string, unknown>> = [];
    content.split(/\r?\n/).forEach((line, idx) => {
      if (line.trim() === "") return;
      try {
        const value: unknown = JSON.parse(line);
        if (isPlain(value)) rows.push(value);
        else findings.push(uploadFinding("dataset.not_object", `line ${idx + 1}: not a JSON object`, idx + 1));
      } catch {
        findings.push(uploadFinding("dataset.load_error", `line ${idx + 1}: invalid JSON`, idx + 1));
      }
    });
    return rows;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : isPlain(parsed) && Array.isArray(parsed.cases) ? parsed.cases : undefined;
    if (list === undefined) {
      findings.push(uploadFinding("dataset.invalid_shape", "JSON must be an array of cases or { cases: [...] }"));
      return [];
    }
    return list.filter(isPlain);
  } catch {
    findings.push(uploadFinding("dataset.load_error", "content is not valid JSON"));
    return [];
  }
}

function stringCell(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function defaultMapping(columns: readonly string[], inputSchema: unknown): UploadMapping {
  const mapping: UploadMapping = {};
  const fields = inputFieldsOf(inputSchema);
  if (fields.length === 0) {
    for (const column of columns) mapping[`input.${column}`] = { column };
    return mapping;
  }
  for (const field of fields) {
    const column = columns.find((c) => c === field.name || c === `input.${field.name}`);
    mapping[`input.${field.name}`] = column === undefined ? null : { column };
  }
  return mapping;
}

function directRows(
  objects: ReadonlyArray<Record<string, unknown>>,
  inputSchema: unknown,
  existingIds: readonly string[],
): UploadPreviewRow[] {
  const shaped = objects.map((raw) => (isPlain(raw.input) ? raw : { input: raw }));
  let next = nextIdNumber([...existingIds, ...shaped.flatMap((o) => (typeof o.id === "string" ? [o.id] : []))]);
  const checks = checkDatasetAgainstStage(
    shaped.map((o, i) => ({ id: String(i), input: o.input as Record<string, unknown> })),
    inputSchema,
  );
  return shaped.map((row, index): UploadPreviewRow => {
    const draft = { ...row, id: typeof row.id === "string" ? row.id : "" } as DatasetCase;
    const unknownKey = Object.keys(row).find((k) => !CASE_KEYS.has(k));
    let reason: string | undefined;
    if (unknownKey !== undefined) reason = `unknown key "${unknownKey}"`;
    else if (draft.id !== "" && !ID_RE.test(draft.id)) reason = `id "${draft.id}" is not valid`;
    else if (!checks[index]?.valid) reason = checks[index]?.message?.replace(/\s+/g, " ").slice(0, 160);
    if (reason !== undefined) return { index, case: draft, status: "skipped", reason };
    if (draft.id === "") {
      draft.id = formatId(next);
      next += 1;
    }
    return { index, case: draft, status: "ready" };
  });
}

export function previewUpload(input: PreviewInput): PreviewResult {
  const findings: ValidationFinding[] = [];
  const existingIds = input.existingIds ?? [];
  if (Buffer.byteLength(input.content, "utf8") > DATASET_LIMITS.maxFileBytes) {
    findings.push(uploadFinding("dataset.file_too_large", `file is larger than ${DATASET_LIMITS.maxFileBytes} bytes`));
    return { rows: [], findings, counts: { ready: 0, skipped: 0 } };
  }

  let columns: string[] | undefined;
  let rows: UploadPreviewRow[] = [];
  if (input.format === "csv") {
    let records: string[][] = [];
    try {
      records = parseCsv(input.content, input.delimiter !== undefined ? { delimiter: input.delimiter } : {});
    } catch (err) {
      findings.push(
        uploadFinding(
          "dataset.load_error",
          err instanceof CsvParseError ? err.message : "invalid CSV",
          err instanceof CsvParseError ? err.record : undefined,
        ),
      );
    }
    const headerIdx = records.findIndex((r) => !(r.length === 1 && r[0] === ""));
    if (headerIdx !== -1) {
      const headers = records[headerIdx]!.map((h) => h.trim());
      columns = headers;
      const body = records
        .slice(headerIdx + 1)
        .filter((r) => !(r.length === 1 && r[0] === ""))
        .map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
      rows = applyUploadMapping(body, input.mapping ?? defaultMapping(headers, input.inputSchema), input.inputSchema, existingIds);
    }
  } else {
    const objects = parseObjectRows(input.format, input.content, findings);
    if (input.mapping !== undefined) {
      const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
      columns = keys;
      const flat = objects.map((o) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, stringCell(o[k])])));
      rows = applyUploadMapping(flat, input.mapping, input.inputSchema, existingIds);
    } else {
      rows = directRows(objects, input.inputSchema, existingIds);
    }
  }

  if (rows.length === 0 && !findings.some((f) => f.severity === "error")) {
    findings.push(uploadFinding("dataset.empty", "no rows found"));
  }
  if (rows.length > DATASET_LIMITS.maxCases) {
    findings.push(uploadFinding("dataset.too_many_cases", `more than ${DATASET_LIMITS.maxCases} rows`));
  }
  const ready = rows.filter((r) => r.status === "ready").length;
  return {
    ...(columns !== undefined ? { columns } : {}),
    rows,
    findings,
    counts: { ready, skipped: rows.length - ready },
  };
}
