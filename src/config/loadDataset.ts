import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CsvParseError, parseCsv } from "./csv.js";
import { datasetContentHash } from "./datasetHash.js";
import type {
  DatasetCase,
  DatasetFormat,
  DatasetLimits,
  DatasetLoadResult,
  ParseDatasetResult,
} from "./datasetTypes.js";
import type { ValidationCategory, ValidationFinding } from "./validateCatalog.js";

export const DATASET_LIMITS: DatasetLimits = {
  maxCases: 5000,
  maxCaseBytes: 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
};

export const DATASET_MIN_CASES = 5;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TAGS = 10;
const MAX_TITLE = 120;
const CASE_KEYS = new Set(["id", "input", "title", "expected", "tags", "goal", "metadata"]);
const DATASET_CATEGORY = "dataset" as ValidationCategory;

export type ParseDatasetOptions = {
  limits?: Partial<DatasetLimits>;
  path?: string;
};

type RawEntry = { value: unknown; pos?: Position };
type Position = { line: number; label: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function datasetFormatFromPath(filePath: string): DatasetFormat | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  return undefined;
}

function finding(
  severity: "error" | "warning",
  code: string,
  filePath: string,
  message: string,
  pos?: Position,
): ValidationFinding {
  const out: ValidationFinding = {
    severity,
    code,
    path: filePath,
    message: pos ? `${pos.label}: ${message}` : message,
    category: DATASET_CATEGORY,
  };
  if (pos && pos.line > 0) out.line = pos.line;
  return out;
}

function parseJsonl(text: string, filePath: string, findings: ValidationFinding[]): RawEntry[] {
  const entries: RawEntry[] = [];
  const lines = text.charCodeAt(0) === 0xfeff ? text.slice(1).split(/\r?\n/) : text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    if (raw.trim() === "") return;
    const pos = { line: idx + 1, label: `line ${idx + 1}` };
    try {
      entries.push({ value: JSON.parse(raw) as unknown, pos });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      findings.push(finding("error", "dataset.load_error", filePath, `invalid JSON (${detail})`, pos));
    }
  });
  return entries;
}

function parseJson(text: string, filePath: string, findings: ValidationFinding[]): RawEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    findings.push(finding("error", "dataset.load_error", filePath, `invalid JSON (${detail})`));
    return [];
  }
  let list: unknown;
  if (Array.isArray(doc)) list = doc;
  else if (isPlainObject(doc) && Array.isArray(doc.cases)) list = doc.cases;
  if (!Array.isArray(list)) {
    findings.push(
      finding(
        "error",
        "dataset.invalid_shape",
        filePath,
        'JSON dataset must be an array of cases or an object { "cases": [...] }',
      ),
    );
    return [];
  }
  return list.map((value, idx) => ({
    value,
    pos: { line: 0, label: `case ${idx + 1}` },
  }));
}

const STRING_COLUMNS = new Set(["id", "title", "goal"]);
const JSON_BASES = new Set(["id", "title", "goal", "tags", "input", "expected", "metadata"]);

type ColumnTarget = {
  base: string;
  key?: string;
  json: boolean;
};

function classifyHeader(header: string): ColumnTarget | undefined {
  const json = header.endsWith(":json");
  const name = json ? header.slice(0, -":json".length) : header;
  if (json && JSON_BASES.has(name)) return { base: name, json };
  if (!json && (STRING_COLUMNS.has(name) || name === "tags" || name === "expected")) {
    return { base: name, json };
  }
  for (const prefix of ["input.", "expected."]) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { base: prefix.slice(0, -1), key: name.slice(prefix.length), json };
    }
  }
  return undefined;
}

function parseCsvEntries(
  text: string,
  filePath: string,
  findings: ValidationFinding[],
  delimiter: string | undefined,
): RawEntry[] {
  let records: string[][];
  try {
    records = parseCsv(text, { delimiter });
  } catch (err) {
    if (err instanceof CsvParseError) {
      findings.push(
        finding("error", "dataset.load_error", filePath, err.message, {
          line: err.record,
          label: `row ${err.record}`,
        }),
      );
      return [];
    }
    throw err;
  }
  const headerIdx = records.findIndex((r) => !(r.length === 1 && r[0] === ""));
  if (headerIdx === -1) return [];
  const headers = records[headerIdx]!.map((h) => h.trim());
  const targets = headers.map((h, col) => {
    const target = classifyHeader(h);
    if (!target) {
      findings.push(
        finding(
          "error",
          "dataset.csv_unknown_column",
          filePath,
          `unknown CSV column "${h}" (column ${col + 1}); use id, title, goal, tags, input.<name>, expected.<name> or a :json suffix`,
          { line: headerIdx + 1, label: `row ${headerIdx + 1}` },
        ),
      );
    }
    return target;
  });

  const entries: RawEntry[] = [];
  for (let r = headerIdx + 1; r < records.length; r += 1) {
    const cells = records[r]!;
    if (cells.length === 1 && cells[0] === "") continue;
    const pos = { line: r + 1, label: `row ${r + 1}` };
    const obj: Record<string, unknown> = {};
    let broken = false;
    targets.forEach((target, col) => {
      const cell = cells[col];
      if (!target || cell === undefined || cell === "") return;
      let value: unknown = cell;
      if (target.json) {
        try {
          value = JSON.parse(cell) as unknown;
        } catch {
          findings.push(
            finding(
              "error",
              "dataset.load_error",
              filePath,
              `column "${headers[col]}" holds invalid JSON`,
              pos,
            ),
          );
          broken = true;
          return;
        }
      } else if (target.base === "tags") {
        value = cell
          .split(";")
          .map((t) => t.trim())
          .filter((t) => t !== "");
      }
      if (target.key !== undefined) {
        const parent = (obj[target.base] ??= {}) as Record<string, unknown>;
        parent[target.key] = value;
      } else {
        obj[target.base] = value;
      }
    });
    if (!broken) entries.push({ value: obj, pos });
  }
  return entries;
}

function validateEntries(
  entries: RawEntry[],
  filePath: string,
  limits: DatasetLimits,
  findings: ValidationFinding[],
): DatasetCase[] {
  const cases: DatasetCase[] = [];
  const seen = new Set<string>();
  let list = entries;
  if (entries.length > limits.maxCases) {
    findings.push(
      finding(
        "error",
        "dataset.too_many_cases",
        filePath,
        `dataset has ${entries.length} cases; the limit is ${limits.maxCases}`,
      ),
    );
    list = entries.slice(0, limits.maxCases);
  }

  for (const { value, pos } of list) {
    const report = (code: string, message: string) => {
      findings.push(finding("error", code, filePath, message, pos));
    };
    if (!isPlainObject(value)) {
      report("dataset.not_object", "case must be a JSON object");
      continue;
    }
    let ok = true;
    const fail = (code: string, message: string) => {
      report(code, message);
      ok = false;
    };

    for (const key of Object.keys(value)) {
      if (!CASE_KEYS.has(key)) fail("dataset.unknown_key", `unknown case key "${key}"`);
    }

    const id = value.id;
    if (id === undefined) {
      fail("dataset.case_missing_id", "case has no id (hand-authored datasets must carry ids)");
    } else if (typeof id !== "string" || !ID_RE.test(id)) {
      fail(
        "dataset.case_invalid_id",
        `id ${JSON.stringify(id)} must match ${ID_RE.source}`,
      );
    } else if (seen.has(id)) {
      fail("dataset.duplicate_id", `duplicate id "${id}"`);
    } else {
      seen.add(id);
    }

    if (value.input === undefined) {
      fail("dataset.case_missing_input", "case has no input");
    } else if (!isPlainObject(value.input)) {
      fail("dataset.invalid_field", "input must be an object");
    }
    if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > MAX_TITLE)) {
      fail("dataset.invalid_field", `title must be a string of at most ${MAX_TITLE} characters`);
    }
    if (value.goal !== undefined && typeof value.goal !== "string") {
      fail("dataset.invalid_field", "goal must be a string");
    }
    if (value.metadata !== undefined && !isPlainObject(value.metadata)) {
      fail("dataset.invalid_field", "metadata must be an object");
    }
    if (value.tags !== undefined) {
      const tags = value.tags;
      if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
        fail("dataset.invalid_field", `tags must be an array of at most ${MAX_TAGS} strings`);
      } else {
        for (const tag of tags) {
          if (typeof tag !== "string" || !TAG_RE.test(tag)) {
            fail("dataset.invalid_field", `tag ${JSON.stringify(tag)} must match ${TAG_RE.source}`);
          }
        }
      }
    }

    if (ok && Buffer.byteLength(JSON.stringify(value), "utf8") > limits.maxCaseBytes) {
      fail(
        "dataset.case_too_large",
        `case "${String(id)}" is larger than ${limits.maxCaseBytes} bytes`,
      );
    }
    if (ok) cases.push(value as DatasetCase);
  }
  return cases;
}

export function parseDatasetText(
  text: string,
  format: DatasetFormat,
  options: ParseDatasetOptions & { csvDelimiter?: string } = {},
): ParseDatasetResult {
  const limits = { ...DATASET_LIMITS, ...options.limits };
  const filePath = options.path ?? "";
  const findings: ValidationFinding[] = [];

  if (Buffer.byteLength(text, "utf8") > limits.maxFileBytes) {
    findings.push(
      finding(
        "error",
        "dataset.file_too_large",
        filePath,
        `dataset file is larger than ${limits.maxFileBytes} bytes`,
      ),
    );
    return { cases: [], findings, contentHash: datasetContentHash([]) };
  }

  let entries: RawEntry[];
  if (format === "jsonl") entries = parseJsonl(text, filePath, findings);
  else if (format === "json") entries = parseJson(text, filePath, findings);
  else entries = parseCsvEntries(text, filePath, findings, options.csvDelimiter);

  const cases = validateEntries(entries, filePath, limits, findings);

  if (entries.length === 0 && !findings.some((f) => f.severity === "error")) {
    findings.push(finding("error", "dataset.empty", filePath, "dataset has no cases"));
  } else if (
    entries.length > 0 &&
    cases.length < DATASET_MIN_CASES &&
    !findings.some((f) => f.severity === "error")
  ) {
    findings.push(
      finding(
        "warning",
        "dataset.few_cases",
        filePath,
        `dataset has ${cases.length} cases; fewer than ${DATASET_MIN_CASES} gives wide error bars`,
      ),
    );
  }

  return { cases, findings, contentHash: datasetContentHash(cases) };
}

export async function loadDatasetFile(
  absPath: string,
  options: ParseDatasetOptions & { root?: string; csvDelimiter?: string } = {},
): Promise<DatasetLoadResult> {
  const limits = { ...DATASET_LIMITS, ...options.limits };
  const relPath = (
    options.root ? path.relative(options.root, absPath) : path.basename(absPath)
  )
    .split(path.sep)
    .join("/");
  const base = {
    path: absPath,
    relPath,
    format: datasetFormatFromPath(absPath),
    cases: [] as DatasetCase[],
    contentHash: datasetContentHash([]),
    fileBytes: 0,
  };
  const fail = (code: string, message: string, fileBytes = 0): DatasetLoadResult => ({
    ...base,
    fileBytes,
    findings: [finding("error", code, relPath, message)],
  });

  if (base.format === undefined) {
    return fail(
      "dataset.load_error",
      `unknown dataset format "${path.extname(absPath)}"; use .jsonl, .json or .csv`,
    );
  }
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch (err) {
    return fail("dataset.load_error", `cannot read dataset: ${(err as Error).message}`);
  }
  if (size > limits.maxFileBytes) {
    return fail(
      "dataset.file_too_large",
      `dataset file is larger than ${limits.maxFileBytes} bytes`,
      size,
    );
  }
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    return fail("dataset.load_error", `cannot read dataset: ${(err as Error).message}`, size);
  }
  const parsed = parseDatasetText(text, base.format, { ...options, path: relPath });
  return { ...base, ...parsed, fileBytes: size };
}
