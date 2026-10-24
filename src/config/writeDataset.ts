import { access } from "node:fs/promises";
import path from "node:path";
import { EvalsWriteError, FileChangedError, writeFileAtomic } from "./atomicWrite.js";
import { ensureCatalogScanRoot } from "./ensureCatalogScanRoot.js";
import { formatId, nextIdNumber } from "./datasetImport.js";
import type { DatasetCase } from "./datasetTypes.js";
import {
  assertInsideProject,
  datasetStem,
  explicitRoots,
  findDatasetFile,
  manifestForWrite,
  resolveWriteDir,
} from "./evalWriteRoots.js";
import { datasetFormatFromPath, loadDatasetFile, parseDatasetText } from "./loadDataset.js";
import type { ValidationFinding } from "./validateCatalog.js";

export type NewDatasetCase = Omit<DatasetCase, "id"> & { id?: string };

export type CaseOp =
  | { op: "add"; case: NewDatasetCase }
  | { op: "update"; id: string; case: NewDatasetCase }
  | { op: "delete"; id: string }
  | { op: "set_tags"; id: string; tags: string[] };

export type DatasetWriteResult = {
  id: string;
  path: string;
  relPath: string;
  text: string;
  hash: string;
  cases: DatasetCase[];
  findings: ValidationFinding[];
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CASE_KEY_ORDER = ["id", "title", "input", "expected", "tags", "goal", "metadata"] as const;

function orderedCase(c: NewDatasetCase): Record<string, unknown> {
  const source = c as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CASE_KEY_ORDER) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (!(key in out) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function renderDatasetJsonl(cases: readonly NewDatasetCase[]): string {
  return cases.map((c) => `${JSON.stringify(orderedCase(c))}\n`).join("");
}

function assignIds(cases: readonly NewDatasetCase[], existingIds: Iterable<string>): DatasetCase[] {
  const taken = [...existingIds, ...cases.flatMap((c) => (c.id !== undefined ? [c.id] : []))];
  let next = nextIdNumber(taken);
  return cases.map((c) => {
    if (c.id !== undefined) return c as DatasetCase;
    const id = formatId(next);
    next += 1;
    return { ...c, id };
  });
}

function assertUniqueIds(cases: readonly DatasetCase[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) {
      throw new EvalsWriteError("DATASET_CASE_OP_INVALID", `duplicate case id "${c.id}"`);
    }
    seen.add(c.id);
  }
}

function checkedCases(text: string, relPath: string): { cases: DatasetCase[]; hash: string; findings: ValidationFinding[] } {
  const parsed = parseDatasetText(text, "jsonl", { path: relPath });
  const errors = parsed.findings.filter((f) => f.severity === "error");
  if (errors.length > 0) {
    throw new EvalsWriteError("DATASET_INVALID", errors[0]!.message, parsed.findings);
  }
  return { cases: parsed.cases, hash: parsed.contentHash, findings: parsed.findings };
}

function relOf(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function createDatasetFile(input: {
  projectRoot: string;
  name: string;
  cases: readonly NewDatasetCase[];
  directory?: string;
}): Promise<DatasetWriteResult> {
  const { projectRoot, name } = input;
  const manifest = await manifestForWrite(projectRoot);
  const dir = await resolveWriteDir(projectRoot, manifest, "datasets", input.directory);
  const absPath = path.join(dir.absDir, `${name}.dataset.jsonl`);
  assertInsideProject(projectRoot, absPath, "dataset path");
  if (!NAME_PATTERN.test(name)) {
    throw new EvalsWriteError("DATASET_NAME_INVALID", `Dataset name must match ${NAME_PATTERN.source}`);
  }
  if ((await findDatasetFile(projectRoot, name, manifest)) !== undefined || (await exists(absPath))) {
    throw new EvalsWriteError("DATASET_EXISTS", `Dataset "${name}" already exists`);
  }

  const cases = assignIds(input.cases, []);
  assertUniqueIds(cases);
  const text = renderDatasetJsonl(cases);
  const relPath = relOf(projectRoot, absPath);
  const checked = checkedCases(text, relPath);
  await writeFileAtomic(absPath, text);

  if (explicitRoots(manifest, "datasets") !== undefined) {
    await ensureCatalogScanRoot(projectRoot, dir.relDir, ["datasets"]);
  }
  return { id: name, path: absPath, relPath, text, ...checked };
}

async function loadEditable(
  projectRoot: string,
  id: string,
  baseHash: string,
  requireJsonl: boolean,
): Promise<{ absPath: string; relPath: string; cases: DatasetCase[]; format: "jsonl" | "json" | "csv" }> {
  const ref = await findDatasetFile(projectRoot, id);
  if (ref === undefined) throw new EvalsWriteError("DATASET_NOT_FOUND", `Dataset "${id}" not found`);
  const format = datasetFormatFromPath(ref.absPath);
  if (format === undefined) throw new EvalsWriteError("DATASET_INVALID", "Unknown dataset format");
  if (requireJsonl && format !== "jsonl") {
    throw new EvalsWriteError(
      "DATASET_READ_ONLY",
      `Dataset "${id}" is .${format}; only .dataset.jsonl is editable. Convert it to JSONL first`,
    );
  }
  const loaded = await loadDatasetFile(ref.absPath, { root: projectRoot });
  if (loaded.contentHash !== baseHash) throw new FileChangedError(loaded.contentHash);
  const errors = loaded.findings.filter((f) => f.severity === "error");
  if (errors.length > 0) {
    throw new EvalsWriteError("DATASET_INVALID", errors[0]!.message, loaded.findings);
  }
  return { absPath: ref.absPath, relPath: ref.relPath, cases: loaded.cases, format };
}

async function commit(
  projectRoot: string,
  target: { absPath: string; relPath: string; id: string },
  cases: readonly DatasetCase[],
  baseHash: string,
): Promise<DatasetWriteResult> {
  assertUniqueIds(cases);
  const text = renderDatasetJsonl(cases);
  const checked = checkedCases(text, target.relPath);
  const recheck = await loadDatasetFile(target.absPath, { root: projectRoot });
  if (recheck.contentHash !== baseHash) throw new FileChangedError(recheck.contentHash);
  await writeFileAtomic(target.absPath, text);
  return { id: target.id, path: target.absPath, relPath: target.relPath, text, ...checked };
}

function opError(index: number, op: CaseOp, message: string): EvalsWriteError {
  return new EvalsWriteError("DATASET_CASE_OP_INVALID", `op ${index} (${op.op}): ${message}`);
}

function applyOps(cases: DatasetCase[], ops: readonly CaseOp[]): DatasetCase[] {
  let working = [...cases];
  ops.forEach((op, index) => {
    if (op.op === "add") {
      if (op.case.id !== undefined && working.some((c) => c.id === op.case.id)) {
        throw opError(index, op, `case "${op.case.id}" already exists`);
      }
      const [added] = assignIds([op.case], working.map((c) => c.id));
      working = [...working, added!];
      return;
    }
    const at = working.findIndex((c) => c.id === op.id);
    if (at === -1) throw opError(index, op, `case "${op.id}" not found`);
    if (op.op === "delete") {
      working = working.filter((_, i) => i !== at);
    } else if (op.op === "update") {
      if (op.case.id !== undefined && op.case.id !== op.id) {
        throw opError(index, op, `case id cannot change from "${op.id}" to "${op.case.id}"`);
      }
      working = working.map((c, i) => (i === at ? ({ ...op.case, id: op.id } as DatasetCase) : c));
    } else if (op.op === "set_tags") {
      working = working.map((c, i) => {
        if (i !== at) return c;
        const { tags: _drop, ...rest } = c;
        return op.tags.length > 0 ? { ...rest, tags: op.tags } : rest;
      });
    } else {
      throw opError(index, op, "unknown op");
    }
  });
  return working;
}

export async function applyCaseOps(input: {
  projectRoot: string;
  id: string;
  baseHash: string;
  ops: readonly CaseOp[];
}): Promise<DatasetWriteResult> {
  const { projectRoot, id, baseHash } = input;
  const current = await loadEditable(projectRoot, id, baseHash, true);
  const next = applyOps(current.cases, input.ops);
  return commit(projectRoot, { ...current, id }, next, baseHash);
}

export async function appendOrReplaceCases(input: {
  projectRoot: string;
  id: string;
  baseHash: string;
  mode: "append" | "replace";
  cases: readonly NewDatasetCase[];
}): Promise<DatasetWriteResult> {
  const { projectRoot, id, baseHash, mode } = input;
  const current = await loadEditable(projectRoot, id, baseHash, true);
  const kept = mode === "append" ? current.cases : [];
  const added = assignIds(input.cases, kept.map((c) => c.id));
  return commit(projectRoot, { ...current, id }, [...kept, ...added], baseHash);
}

export async function convertDatasetToJsonl(input: {
  projectRoot: string;
  id: string;
  baseHash: string;
}): Promise<DatasetWriteResult> {
  const { projectRoot, id, baseHash } = input;
  const current = await loadEditable(projectRoot, id, baseHash, false);
  if (current.format === "jsonl") {
    throw new EvalsWriteError("DATASET_INVALID", `Dataset "${id}" is already .dataset.jsonl`);
  }
  const absPath = path.join(path.dirname(current.absPath), `${datasetStem(path.basename(current.absPath))}.dataset.jsonl`);
  if (await exists(absPath)) {
    throw new EvalsWriteError("DATASET_EXISTS", `${path.basename(absPath)} already exists`);
  }
  const relPath = relOf(projectRoot, absPath);
  const text = renderDatasetJsonl(current.cases);
  const checked = checkedCases(text, relPath);
  await writeFileAtomic(absPath, text);
  return { id: datasetStem(path.basename(absPath)), path: absPath, relPath, text, ...checked };
}
