import { access, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from "yaml";
import type { EvalFile } from "../evals/types.js";
import {
  assertBaseHash,
  contentHash,
  EvalsWriteError,
  FileChangedError,
  writeFileAtomic,
} from "./atomicWrite.js";
import { ensureCatalogScanRoot } from "./ensureCatalogScanRoot.js";
import {
  assertInsideProject,
  explicitRoots,
  findEvalFile,
  manifestForWrite,
  resolveWriteDir,
} from "./evalWriteRoots.js";
import {
  EVAL_DEFAULT_CONCURRENCY,
  EVAL_DEFAULT_MAX_COST_USD,
  EVAL_DEFAULT_PASS_THRESHOLD,
  EVAL_DEFAULT_REPEATS,
  parseEvalOutcome,
} from "./loadEval.js";
import { evalFindingsFromIssues } from "./validateEval.js";
import type { ValidationFinding } from "./validateCatalog.js";

const TOP_ORDER = [
  "version",
  "id",
  "name",
  "description",
  "type",
  "target",
  "dataset",
  "task",
  "defaults",
  "graders",
  "budget",
];
const TARGET_ORDER = ["kind", "pipeline", "stage", "file"];
const TASK_ORDER = ["goal", "context", "constraints"];
const DEFAULTS_ORDER = ["repeats", "judge", "pass_threshold", "max_cost_usd", "concurrency", "model"];
const BUDGET_ORDER = ["latency_ms", "cost_usd"];
const GRADER_COMMON_ORDER = ["id", "type", "description", "weight", "must_pass"];
const GRADER_TYPE_ORDER: Record<string, string[]> = {
  schema: [],
  field: ["checks"],
  reference: ["mode", "path", "expected", "pass_at"],
  rubric: ["rubric", "scale", "pass_at", "judge", "examples"],
  code: ["code"],
};
const CHECK_ORDER = ["path", "op", "value"];

export type EvalWriteResult = {
  id: string;
  path: string;
  relPath: string;
  text: string;
  fileHash: string;
  findings: ValidationFinding[];
};

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ordered(value: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  for (const key of Object.keys(value)) {
    if (!(key in out) && value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function graderOrder(grader: Record<string, unknown>): string[] {
  const typeKeys = typeof grader.type === "string" ? (GRADER_TYPE_ORDER[grader.type] ?? []) : [];
  return [...GRADER_COMMON_ORDER, ...typeKeys];
}

function orderedGrader(grader: Record<string, unknown>): Record<string, unknown> {
  const out = ordered(grader, graderOrder(grader));
  if (Array.isArray(out.checks)) {
    out.checks = out.checks.map((c) => (isPlain(c) ? ordered(c, CHECK_ORDER) : c));
  }
  if (Array.isArray(out.examples)) {
    out.examples = out.examples.map((e) =>
      isPlain(e) ? ordered(e, ["verdict", "score", "output", "reason"]) : e,
    );
  }
  return out;
}

function orderedDefinition(definition: unknown): unknown {
  if (!isPlain(definition)) return definition;
  const out = ordered(definition, TOP_ORDER);
  const subs: Array<[string, readonly string[]]> = [
    ["target", TARGET_ORDER],
    ["task", TASK_ORDER],
    ["defaults", DEFAULTS_ORDER],
    ["budget", BUDGET_ORDER],
  ];
  for (const [key, order] of subs) {
    if (isPlain(out[key])) out[key] = ordered(out[key], order);
  }
  if (Array.isArray(out.graders)) {
    out.graders = out.graders.map((g) => (isPlain(g) ? orderedGrader(g) : g));
  }
  return out;
}

function styleNode(node: unknown, keys: string[]): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      styleNode(pair.value, [...keys, key]);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (keys[keys.length - 1] === "checks" && isMap(item)) item.flow = true;
      styleNode(item, [...keys, "[]"]);
    }
  } else if (isScalar(node) && typeof node.value === "string") {
    if (keys[keys.length - 1] === "output" && keys[keys.length - 3] === "examples") {
      node.type = Scalar.QUOTE_DOUBLE;
    } else if (node.value.includes("\n")) {
      node.type = Scalar.BLOCK_LITERAL;
    }
  }
}

const STRINGIFY = { indent: 2, lineWidth: 0 } as const;

function toText(doc: Document): string {
  const text = doc.toString(STRINGIFY);
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function renderEvalYaml(definition: unknown): string {
  const doc = new Document(orderedDefinition(definition));
  styleNode(doc.contents, []);
  return toText(doc);
}

function fillCreateDefaults(definition: EvalFile): EvalFile {
  return {
    ...definition,
    defaults: {
      repeats: EVAL_DEFAULT_REPEATS,
      pass_threshold: EVAL_DEFAULT_PASS_THRESHOLD,
      max_cost_usd: EVAL_DEFAULT_MAX_COST_USD,
      ...definition.defaults,
    },
  };
}

export function renderEvalCreateYaml(definition: EvalFile): string {
  return renderEvalYaml(fillCreateDefaults(definition));
}

function isOmittableDefault(keys: string[], value: unknown, parent: Record<string, unknown>): boolean {
  const key = keys[keys.length - 1];
  if (keys.length === 1) return key === "type" && value === "capability";
  if (keys.length === 2 && keys[0] === "defaults") {
    return (
      (key === "repeats" && value === EVAL_DEFAULT_REPEATS) ||
      (key === "pass_threshold" && value === EVAL_DEFAULT_PASS_THRESHOLD) ||
      (key === "max_cost_usd" && value === EVAL_DEFAULT_MAX_COST_USD) ||
      (key === "concurrency" && value === EVAL_DEFAULT_CONCURRENCY)
    );
  }
  if (keys.length === 3 && keys[0] === "graders") {
    if (key === "weight") return value === 1;
    if (key === "must_pass") return value === false;
    if (key === "scale") return value === "pass_fail";
    if (key === "path") return parent.type === "reference" && value === "payload";
    if (key === "pass_at") {
      if (parent.type === "reference") return value === 1;
      if (parent.type === "rubric") return parent.scale === "1_to_5" && value === 4;
    }
  }
  return false;
}

function create(doc: Document, value: unknown, keys: string[]): unknown {
  const node = doc.createNode(value);
  styleNode(node, keys);
  return node;
}

function carryComments(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return;
  if (from.comment !== undefined) to.comment = from.comment;
  if (from.commentBefore !== undefined) to.commentBefore = from.commentBefore;
  if (from.spaceBefore) to.spaceBefore = true;
}

function replace(doc: Document, old: unknown, value: unknown, keys: string[]): unknown {
  const node = create(doc, value, keys);
  carryComments(old, node);
  return node;
}

function pairKey(pair: { key: unknown }): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function syncValue(doc: Document, node: unknown, value: unknown, keys: string[]): unknown {
  if (isPlain(value)) {
    if (!isMap(node)) return replace(doc, node, value, keys);
    syncMap(doc, node, value, keys);
    return node;
  }
  if (Array.isArray(value)) {
    if (!isSeq(node)) return replace(doc, node, value, keys);
    syncSeq(doc, node, value, keys);
    return node;
  }
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    if (node.value !== value) {
      node.value = value;
      if (typeof value === "string" && value.includes("\n")) {
        if (node.type !== Scalar.BLOCK_FOLDED) node.type = Scalar.BLOCK_LITERAL;
      } else if (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED) {
        node.type = undefined;
      }
    }
    return node;
  }
  return replace(doc, node, value, keys);
}

function syncMap(doc: Document, map: YAMLMap, value: Record<string, unknown>, keys: string[]): void {
  const desired = Object.keys(value).filter((k) => value[k] !== undefined);
  map.items = map.items.filter((pair) => desired.includes(pairKey(pair)));
  let lastIndex = -1;
  for (const key of desired) {
    const childKeys = [...keys, key];
    const index = map.items.findIndex((pair) => pairKey(pair) === key);
    if (index >= 0) {
      const pair = map.items[index]!;
      pair.value = syncValue(doc, pair.value, value[key], childKeys) as typeof pair.value;
      lastIndex = index;
      continue;
    }
    if (isOmittableDefault(childKeys, value[key], value)) continue;
    const pair = doc.createPair(key, create(doc, value[key], childKeys));
    map.items.splice(lastIndex + 1, 0, pair);
    lastIndex += 1;
  }
}

function itemId(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const id = node.get("id");
  return typeof id === "string" ? id : undefined;
}

function syncSeq(doc: Document, seq: YAMLSeq, value: unknown[], keys: string[]): void {
  const byId = keys[keys.length - 1] === "graders";
  const childKeys = [...keys, "[]"];
  const used = new Set<unknown>();
  const next = value.map((item, index) => {
    let existing: unknown;
    if (byId) {
      const id = isPlain(item) && typeof item.id === "string" ? item.id : undefined;
      existing = seq.items.find((n) => !used.has(n) && id !== undefined && itemId(n) === id);
    } else {
      existing = seq.items[index];
    }
    if (existing === undefined) return create(doc, item, childKeys);
    used.add(existing);
    return syncValue(doc, existing, item, childKeys);
  });
  seq.items = next as typeof seq.items;
}

export function previewEvalUpdate(currentText: string, definition: unknown): string {
  const doc = parseDocument(currentText);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return renderEvalYaml(definition);
  const target = orderedDefinition(definition);
  if (!isPlain(target)) return renderEvalYaml(definition);
  if (isDeepStrictEqual(doc.toJS(), JSON.parse(JSON.stringify(target)))) return currentText;
  syncMap(doc, doc.contents, target, []);
  return toText(doc);
}

function relOf(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

function validateEvalText(text: string, absPath: string, projectRoot: string): ValidationFinding[] {
  const outcome = parseEvalOutcome(text, absPath, projectRoot);
  const relPath = relOf(projectRoot, absPath);
  if (!outcome.ok) {
    const findings = evalFindingsFromIssues(relPath, outcome.issues);
    throw new EvalsWriteError(
      "EVAL_INVALID",
      findings.find((f) => f.severity === "error")?.message ?? "Eval definition is invalid",
      findings,
    );
  }
  return evalFindingsFromIssues(relPath, outcome.issues ?? []);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function createEvalFile(input: {
  projectRoot: string;
  definition: EvalFile;
  directory?: string;
}): Promise<EvalWriteResult> {
  const { projectRoot, definition } = input;
  const manifest = await manifestForWrite(projectRoot);
  const dir = await resolveWriteDir(projectRoot, manifest, "evals", input.directory);
  const rawId = (definition as { id?: unknown }).id;
  const fileName = `${typeof rawId === "string" ? rawId : "new"}.eval.yaml`;
  const absPath = path.join(dir.absDir, fileName);
  assertInsideProject(projectRoot, absPath, "eval path");

  if (typeof rawId === "string") {
    if ((await findEvalFile(projectRoot, rawId, manifest)) !== undefined || (await exists(absPath))) {
      throw new EvalsWriteError("EVAL_EXISTS", `Eval "${rawId}" already exists`);
    }
  }

  const text = renderEvalYaml(fillCreateDefaults(definition));
  const findings = validateEvalText(text, absPath, projectRoot);
  await writeFileAtomic(absPath, text);

  const named = explicitRoots(manifest, "evals");
  if (named !== undefined) await ensureCatalogScanRoot(projectRoot, dir.relDir, ["evals"]);

  return {
    id: rawId as string,
    path: absPath,
    relPath: relOf(projectRoot, absPath),
    text,
    fileHash: contentHash(text),
    findings,
  };
}

export async function updateEvalFile(input: {
  projectRoot: string;
  id: string;
  definition?: unknown;
  yaml?: string;
  baseHash: string;
}): Promise<EvalWriteResult> {
  const { projectRoot, id, baseHash } = input;
  if ((input.definition === undefined) === (input.yaml === undefined)) {
    throw new EvalsWriteError("EVAL_INVALID", "Provide exactly one of definition or yaml");
  }
  const ref = await findEvalFile(projectRoot, id);
  if (ref === undefined) throw new EvalsWriteError("EVAL_NOT_FOUND", `Eval "${id}" not found`);

  const current = await readFile(ref.absPath);
  const currentHash = contentHash(current);
  if (currentHash !== baseHash) throw new FileChangedError(currentHash);

  const text =
    input.yaml !== undefined
      ? input.yaml.endsWith("\n")
        ? input.yaml
        : `${input.yaml}\n`
      : previewEvalUpdate(current.toString("utf8"), input.definition);
  const findings = validateEvalText(text, ref.absPath, projectRoot);

  await assertBaseHash(ref.absPath, baseHash);
  await writeFileAtomic(ref.absPath, text);

  return {
    id,
    path: ref.absPath,
    relPath: ref.relPath,
    text,
    fileHash: contentHash(text),
    findings,
  };
}
