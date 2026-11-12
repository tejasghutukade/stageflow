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
  type Pair,
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

function deepEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(normalize(a), normalize(b));
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

function itemId(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const id = node.get("id");
  return typeof id === "string" ? id : undefined;
}

function itemUses(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const uses = node.get("uses");
  return typeof uses === "string" ? normalizeUses(uses) : undefined;
}

function normalizeUses(uses: string): string {
  return uses.trim().replace(/^\.\//, "");
}

function unchanged(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  keepUnknownTopLevel: boolean,
): boolean {
  if (!keepUnknownTopLevel) return deepEqual(current, next);
  for (const key of EDITOR_PIPELINE_KEYS) {
    const nextHas = next[key] !== undefined;
    const currentHas = current[key] !== undefined;
    if (nextHas !== currentHas) return false;
    if (nextHas && !deepEqual(current[key], next[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: bring the parsed document's nodes in line with `next`, reusing every
// node that still applies so comments, styles and source ranges stay attached.
// ---------------------------------------------------------------------------

type SyncContext = { doc: Document; original: WeakMap<object, unknown> };

function replaceNode(ctx: SyncContext, old: unknown, value: unknown): unknown {
  const node = ctx.doc.createNode(value);
  carryComments(old, node);
  return node;
}

function syncValue(ctx: SyncContext, node: unknown, value: unknown): unknown {
  // An untouched subtree keeps its nodes as they are (aliases included).
  if (isNode(node) && ctx.original.has(node) && deepEqual(ctx.original.get(node), value)) return node;
  if (isPlain(value)) {
    if (!isMap(node)) return replaceNode(ctx, node, value);
    syncMap(ctx, node, value, null);
    return node;
  }
  if (Array.isArray(value)) {
    if (!isSeq(node)) return replaceNode(ctx, node, value);
    syncSeq(ctx, node, value);
    return node;
  }
  if (isScalar(node) && (value === null || typeof value !== "object")) {
    if (!deepEqual(node.value, value)) {
      if (typeof node.value !== typeof value) node.type = undefined;
      node.value = value as typeof node.value;
      if (typeof value === "string" && value.includes("\n")) {
        if (node.type !== Scalar.BLOCK_FOLDED) node.type = Scalar.BLOCK_LITERAL;
      } else if (node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) {
        node.type = undefined;
      }
    }
    return node;
  }
  return replaceNode(ctx, node, value);
}

function syncMap(
  ctx: SyncContext,
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
      pair.value = syncValue(ctx, pair.value, value[key]) as typeof pair.value;
      lastIndex = Math.max(lastIndex, index);
      continue;
    }
    const pair = ctx.doc.createPair(key, ctx.doc.createNode(value[key]));
    map.items.splice(lastIndex + 1, 0, pair);
    lastIndex += 1;
  }
}

/**
 * Which existing item each desired item continues: same `id`; for an item with no id, the same `uses`; an
 * identical unclaimed item; and, for a renamed item whose new id appears nowhere in the file, the unclaimed item
 * at its position whose old id is no longer wanted. Anything else is new.
 */
function matchSeqItems(seq: YAMLSeq, value: unknown[], original: WeakMap<object, unknown>): (unknown | undefined)[] {
  const claimed = new Set<unknown>();
  const items = seq.items;
  const desiredIds = new Set(value.filter(isPlain).map((item) => item.id).filter((id): id is string => typeof id === "string"));
  const existingIds = new Set(items.map(itemId).filter((id): id is string => id !== undefined));
  const result: (unknown | undefined)[] = value.map(() => undefined);
  const claim = (index: number, node: unknown) => {
    result[index] = node;
    claimed.add(node);
  };
  value.forEach((item, index) => {
    if (isPlain(item) && typeof item.id === "string") {
      const node = items.find((n) => !claimed.has(n) && itemId(n) === item.id);
      if (node !== undefined) claim(index, node);
    }
  });
  value.forEach((item, index) => {
    if (result[index] !== undefined || !isPlain(item) || item.id !== undefined || typeof item.uses !== "string") return;
    const uses = normalizeUses(item.uses);
    const node = items.find((n) => !claimed.has(n) && itemId(n) === undefined && itemUses(n) === uses);
    if (node !== undefined) claim(index, node);
  });
  value.forEach((item, index) => {
    if (result[index] !== undefined) return;
    const node = items.find((n) => !claimed.has(n) && isNode(n) && deepEqual(original.get(n), item));
    if (node !== undefined) claim(index, node);
  });
  value.forEach((item, index) => {
    if (result[index] !== undefined) return;
    const node = items[index];
    if (node === undefined || claimed.has(node)) return;
    const oldId = itemId(node);
    if (isPlain(item) && typeof item.id === "string") {
      // A rename: the new id is not in the file and the old one is no longer wanted.
      if (!existingIds.has(item.id) && oldId !== undefined && !desiredIds.has(oldId)) claim(index, node);
      return;
    }
    if (oldId === undefined && itemUses(node) === undefined) claim(index, node);
  });
  return result;
}

function syncSeq(ctx: SyncContext, seq: YAMLSeq, value: unknown[]): void {
  const matches = matchSeqItems(seq, value, ctx.original);
  seq.items = value.map((item, index) => {
    const existing = matches[index];
    if (existing === undefined) return ctx.doc.createNode(item);
    return syncValue(ctx, existing, item);
  }) as typeof seq.items;
}

// ---------------------------------------------------------------------------
// Step 2: write only what changed. Untouched text is copied byte for byte from
// the original; a changed node's source range is replaced with that node
// printed on its own, at the original indentation.
// ---------------------------------------------------------------------------

type Edit = { start: number; end: number; text: string };
type Snapshot = { js: unknown; items: unknown[] | undefined };
type PlanContext = { doc: Document; source: string; snap: WeakMap<object, Snapshot> };

function snapshot(doc: Document, node: unknown, snap: WeakMap<object, Snapshot>, original: WeakMap<object, unknown>): void {
  if (!isNode(node)) return;
  const js = node.toJS(doc);
  original.set(node, js);
  snap.set(node, { js, items: isMap(node) || isSeq(node) ? [...node.items] : undefined });
  if (isMap(node)) for (const pair of node.items) snapshot(doc, pair.value, snap, original);
  if (isSeq(node)) for (const item of node.items) snapshot(doc, item, snap, original);
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

function column(source: string, offset: number): number {
  return offset - lineStart(source, offset);
}

function stripBefore<T>(node: T): T {
  if (isNode(node)) {
    node.commentBefore = undefined;
    node.spaceBefore = false;
  }
  return node;
}

/** Print `contents` as its own document, with its first-line comments dropped (they sit outside the range). */
function printAlone(contents: unknown): string {
  const doc = new Document();
  doc.contents = contents as Document["contents"];
  return doc.toString(STRINGIFY);
}

/** Indent every line after the first by `col` spaces, so a block printed at column 0 fits at `col`. */
function indentTail(text: string, col: number): string {
  const pad = " ".repeat(col);
  const lines = text.split("\n");
  return lines.map((line, index) => (index === 0 || line === "" ? line : pad + line)).join("\n");
}

function printPair(pair: Pair, col: number): string {
  const clone = pair.clone() as Pair;
  stripBefore(clone.key);
  const map = new YAMLMap();
  map.items = [clone];
  return indentTail(printAlone(map), col);
}

function printSeqItem(item: unknown, col: number): string {
  const node = isNode(item) ? stripBefore(item.clone()) : item;
  const seq = new YAMLSeq();
  seq.items = [node];
  return indentTail(printAlone(seq), col);
}

function inlineScalar(node: Scalar): string | null {
  const original = node.type;
  if (original === Scalar.BLOCK_FOLDED || original === Scalar.BLOCK_LITERAL) return null;
  const clone = stripBefore(node.clone() as Scalar);
  clone.comment = undefined;
  const text = printAlone(clone).replace(/\n$/, "");
  return text.includes("\n") ? null : text;
}

/** Edits that turn `node`'s original text into `value`, or null when its parent must reprint it. */
function plan(ctx: PlanContext, node: unknown, value: unknown): Edit[] | null {
  if (!isNode(node)) return null;
  const snap = ctx.snap.get(node);
  if (snap === undefined || node.range == null) return null;
  if (deepEqual(snap.js, value)) return [];
  if (isScalar(node)) {
    if (value !== null && typeof value === "object") return null;
    const text = inlineScalar(node);
    return text === null ? null : [{ start: node.range[0], end: node.range[1], text }];
  }
  if (isMap(node) && isPlain(value) && !node.flow) return planMap(ctx, node, snap);
  if (isSeq(node) && Array.isArray(value) && !node.flow) return planSeq(ctx, node, snap);
  return null;
}

function finalValue(ctx: PlanContext, node: unknown): unknown {
  return isNode(node) ? node.toJS(ctx.doc) : node;
}

function keptInOrder(current: unknown[], original: unknown[]): boolean {
  let last = -1;
  for (const item of current) {
    const index = original.indexOf(item);
    if (index < 0) continue;
    if (index < last) return false;
    last = index;
  }
  return true;
}

function nodeEnd(node: unknown): number | undefined {
  return isNode(node) && node.range != null ? node.range[2] : undefined;
}

function planMap(ctx: PlanContext, map: YAMLMap, snap: Snapshot): Edit[] | null {
  const originalPairs = (snap.items ?? []) as Pair[];
  const pairs = map.items as Pair[];
  if (!keptInOrder(pairs, originalPairs)) return null;
  const edits: Edit[] = [];
  for (const pair of originalPairs) {
    if (pairs.includes(pair)) continue;
    const keyStart = isNode(pair.key) ? pair.key.range?.[0] : undefined;
    const end = nodeEnd(pair.value) ?? (isNode(pair.key) ? pair.key.range?.[2] : undefined);
    if (keyStart === undefined || end === undefined) return null;
    edits.push({ start: lineStart(ctx.source, keyStart), end, text: "" });
  }
  const firstKey = originalPairs.find((pair) => isNode(pair.key) && pair.key.range != null)?.key;
  if (!isNode(firstKey) || firstKey.range == null) return null;
  const col = column(ctx.source, firstKey.range[0]);
  let insertAt = lineStart(ctx.source, firstKey.range[0]);
  for (const pair of pairs) {
    if (originalPairs.includes(pair)) {
      const keyStart = isNode(pair.key) ? pair.key.range?.[0] : undefined;
      const end = nodeEnd(pair.value);
      if (keyStart === undefined || end === undefined) return null;
      const sub = plan(ctx, pair.value, finalValue(ctx, pair.value));
      if (sub === null) {
        edits.push({ start: keyStart, end, text: endWithNewline(printPair(pair, col), ctx.source, end) });
      } else {
        edits.push(...sub);
      }
      insertAt = end;
      continue;
    }
    const prefix = insertAt > 0 && ctx.source[insertAt - 1] !== "\n" ? "\n" : "";
    edits.push({ start: insertAt, end: insertAt, text: prefix + " ".repeat(col) + printPair(pair, col) });
  }
  return edits;
}

function planSeq(ctx: PlanContext, seq: YAMLSeq, snap: Snapshot): Edit[] | null {
  const originalItems = snap.items ?? [];
  const items = seq.items;
  if (!keptInOrder(items, originalItems)) return null;
  const first = originalItems.find((item) => isNode(item) && item.range != null);
  if (!isNode(first) || first.range == null) return null;
  const itemCol = column(ctx.source, first.range[0]);
  const dash = ctx.source.lastIndexOf("-", first.range[0]);
  if (dash < 0 || dash < lineStart(ctx.source, first.range[0])) return null;
  const dashCol = column(ctx.source, dash);
  const edits: Edit[] = [];
  for (const item of originalItems) {
    if (items.includes(item)) continue;
    if (!isNode(item) || item.range == null) return null;
    edits.push({ start: lineStart(ctx.source, item.range[0]), end: item.range[2], text: "" });
  }
  let insertAt = lineStart(ctx.source, first.range[0]);
  for (const item of items) {
    if (originalItems.includes(item)) {
      if (!isNode(item) || item.range == null) return null;
      const sub = plan(ctx, item, finalValue(ctx, item));
      if (sub === null) {
        const printed = indentTail(printAlone(stripBefore(item.clone())), itemCol);
        edits.push({ start: item.range[0], end: item.range[2], text: endWithNewline(printed, ctx.source, item.range[2]) });
      } else {
        edits.push(...sub);
      }
      insertAt = item.range[2];
      continue;
    }
    const prefix = insertAt > 0 && ctx.source[insertAt - 1] !== "\n" ? "\n" : "";
    edits.push({ start: insertAt, end: insertAt, text: prefix + " ".repeat(dashCol) + printSeqItem(item, dashCol) });
  }
  return edits;
}

/** A replaced range keeps whatever line ending it had: drop the printed newline if the original had none. */
function endWithNewline(printed: string, source: string, end: number): string {
  const hadNewline = end > 0 && source[end - 1] === "\n";
  if (hadNewline) return printed.endsWith("\n") ? printed : `${printed}\n`;
  return printed.replace(/\n$/, "");
}

function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > floor) throw new Error("overlapping edits");
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/**
 * Apply `next` onto the existing YAML text. An unchanged file is returned byte for byte. A changed file keeps
 * every untouched byte: comments, quoting, folded blocks, flow maps, anchors and line endings. Only the changed
 * nodes are printed. Pipeline files keep top-level keys the editor does not model.
 */
export function renderCatalogYaml(
  existing: string | null,
  next: Record<string, unknown>,
  options: { keepUnknownTopLevel: boolean },
): string {
  if (existing === null) return stringifyTargetYaml(next);
  const crlf = existing.includes("\r\n");
  const source = crlf ? existing.replace(/\r\n/g, "\n") : existing;
  const doc = parseDocument(source);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return stringifyTargetYaml(next);
  const current = doc.toJS();
  if (!isPlain(current)) return stringifyTargetYaml(next);
  if (unchanged(current, next, options.keepUnknownTopLevel)) return existing;

  const snap = new WeakMap<object, Snapshot>();
  const original = new WeakMap<object, unknown>();
  snapshot(doc, doc.contents, snap, original);
  const root = doc.contents;
  syncMap({ doc, original }, root, next, options.keepUnknownTopLevel ? EDITOR_PIPELINE_KEYS : null);

  let text: string;
  try {
    const edits = planMap({ doc, source, snap }, root, snap.get(root)!);
    text = edits === null ? toText(doc) : applyEdits(source, edits);
  } catch {
    text = toText(doc);
  }
  if (!deepEqual(parseDocument(text).toJS(), doc.toJS())) text = toText(doc);
  return crlf ? text.replace(/\r?\n/g, "\r\n") : text;
}

