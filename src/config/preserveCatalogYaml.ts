import { isDeepStrictEqual } from "node:util";
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
import { stringifyTargetYaml } from "./printTargetYaml.js";

/**
 * Top-level keys the editor loads and writes back. Every other top-level key
 * (`independence`, `include`, and anything else hand-written) stays in the file.
 */
const EDITOR_PIPELINE_KEYS = new Set([
  "id",
  "stages",
  "agent",
  "model",
  "schemas",
  "requires",
  "channels",
  "memories",
]);

const STRINGIFY = { indent: 2, lineWidth: 0 } as const;

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function pairKey(pair: { key: unknown }): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function toText(doc: Document): string {
  const text = doc.toString(STRINGIFY);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function carryComments(from: unknown, to: unknown): void {
  if (!isNode(from) || !isNode(to)) return;
  if (from.comment !== undefined) to.comment = from.comment;
  if (from.commentBefore !== undefined) to.commentBefore = from.commentBefore;
  if (from.spaceBefore) to.spaceBefore = true;
}

function leafEqual(node: unknown, value: unknown): boolean {
  if (!isScalar(node)) return false;
  if (node.value === value) return true;
  return isDeepStrictEqual(normalize(node.value), normalize(value));
}

function itemId(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const id = node.get("id");
  return typeof id === "string" ? id : undefined;
}

function unchanged(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  keepUnknownTopLevel: boolean,
): boolean {
  if (!keepUnknownTopLevel) {
    return isDeepStrictEqual(normalize(current), normalize(next));
  }
  for (const key of EDITOR_PIPELINE_KEYS) {
    const nextHas = next[key] !== undefined;
    const currentHas = current[key] !== undefined;
    if (nextHas !== currentHas) return false;
    if (nextHas && !isDeepStrictEqual(normalize(current[key]), normalize(next[key]))) {
      return false;
    }
  }
  return true;
}

function createNode(doc: Document, value: unknown): unknown {
  return doc.createNode(value);
}

function replaceNode(doc: Document, old: unknown, value: unknown): unknown {
  const node = createNode(doc, value);
  carryComments(old, node);
  return node;
}

function syncValue(doc: Document, node: unknown, value: unknown): unknown {
  if (isPlain(value)) {
    if (!isMap(node)) return replaceNode(doc, node, value);
    syncMap(doc, node, value, null);
    return node;
  }
  if (Array.isArray(value)) {
    if (!isSeq(node)) return replaceNode(doc, node, value);
    syncSeq(doc, node, value);
    return node;
  }
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    if (!leafEqual(node, value)) {
      if (typeof node.value !== typeof value) node.type = undefined;
      node.value = value as typeof node.value;
      if (typeof value === "string" && value.includes("\n")) {
        if (node.type !== Scalar.BLOCK_FOLDED) node.type = Scalar.BLOCK_LITERAL;
      }
    }
    return node;
  }
  return replaceNode(doc, node, value);
}

function syncMap(
  doc: Document,
  map: YAMLMap,
  value: Record<string, unknown>,
  retainUnknown: ReadonlySet<string> | null,
): void {
  const desired = Object.keys(value).filter((key) => value[key] !== undefined);
  const desiredSet = new Set(desired);
  map.items = map.items.filter((pair) => {
    const key = pairKey(pair);
    if (desiredSet.has(key)) return true;
    return retainUnknown !== null && !retainUnknown.has(key);
  });
  let lastIndex = -1;
  for (const key of desired) {
    const index = map.items.findIndex((pair) => pairKey(pair) === key);
    if (index >= 0) {
      const pair = map.items[index]!;
      pair.value = syncValue(doc, pair.value, value[key]) as typeof pair.value;
      lastIndex = index;
      continue;
    }
    const pair = doc.createPair(key, createNode(doc, value[key]));
    map.items.splice(lastIndex + 1, 0, pair);
    lastIndex += 1;
  }
}

function syncSeq(doc: Document, seq: YAMLSeq, value: unknown[]): void {
  const used = new Set<unknown>();
  const next = value.map((item, index) => {
    let existing: unknown;
    if (isPlain(item) && typeof item.id === "string") {
      existing = seq.items.find((node) => !used.has(node) && itemId(node) === item.id);
    }
    if (existing === undefined) {
      const byIndex = seq.items[index];
      if (byIndex !== undefined && !used.has(byIndex) && itemId(byIndex) === undefined) {
        existing = byIndex;
      }
    }
    if (existing === undefined) return createNode(doc, item);
    used.add(existing);
    return syncValue(doc, existing, item);
  });
  seq.items = next as typeof seq.items;
}

/**
 * Apply `next` onto the existing YAML text. An unchanged file is returned
 * byte-for-byte. A changed file is reprinted from the parsed document so
 * comments and untouched quoting stay, as far as the YAML library allows.
 * Pipeline files keep top-level keys the editor does not model.
 */
export function renderCatalogYaml(
  existing: string | null,
  next: Record<string, unknown>,
  options: { keepUnknownTopLevel: boolean },
): string {
  if (existing === null) return stringifyTargetYaml(next);
  const doc = parseDocument(existing);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return stringifyTargetYaml(next);
  const current = doc.toJS();
  if (!isPlain(current)) return stringifyTargetYaml(next);
  if (unchanged(current, next, options.keepUnknownTopLevel)) return existing;
  syncMap(
    doc,
    doc.contents,
    next,
    options.keepUnknownTopLevel ? EDITOR_PIPELINE_KEYS : null,
  );
  return toText(doc);
}
