import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import type { DatasetCase } from "./datasetTypes.js";

export type UploadMappingEntry = { column: string; split?: string } | null;

export type UploadMapping = Record<string, UploadMappingEntry>;

export type UploadPreviewRow = {
  index: number;
  case: DatasetCase;
  status: "ready" | "skipped";
  reason?: string;
};

const REASON_MAX = 160;
const ID_NUMBER_RE = /^c(\d+)$/;

function trimReason(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > REASON_MAX ? flat.slice(0, REASON_MAX) : flat;
}

function nextIdNumber(existingIds: Iterable<string>): number {
  let max = 0;
  for (const id of existingIds) {
    const m = ID_NUMBER_RE.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function formatId(n: number): string {
  return `c${String(n).padStart(3, "0")}`;
}

function schemaPropertyType(inputSchema: unknown, name: string): string | undefined {
  if (inputSchema === null || typeof inputSchema !== "object") return undefined;
  const props = (inputSchema as { properties?: unknown }).properties;
  if (props === null || typeof props !== "object") return undefined;
  const prop = (props as Record<string, unknown>)[name];
  if (prop === null || typeof prop !== "object") return undefined;
  const type = (prop as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function parseCell(
  cell: string,
  schemaType: string | undefined,
  split: string | undefined,
  name: string,
): { value: unknown } | { error: string } {
  if (split !== undefined) {
    return {
      value: cell
        .split(split)
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    };
  }
  if (schemaType === "number" || schemaType === "integer") {
    const trimmed = cell.trim();
    const n = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(n) || (schemaType === "integer" && !Number.isInteger(n))) {
      return { error: `${name} is not ${schemaType === "integer" ? "an integer" : "a number"}` };
    }
    return { value: n };
  }
  if (schemaType === "boolean") {
    const lowered = cell.trim().toLowerCase();
    if (lowered === "true") return { value: true };
    if (lowered === "false") return { value: false };
    return { error: `${name} is not a boolean` };
  }
  return { value: cell };
}

export function applyUploadMapping(
  rows: ReadonlyArray<Record<string, string>>,
  mapping: UploadMapping,
  inputSchema: unknown,
  existingIds: Iterable<string>,
): UploadPreviewRow[] {
  let nextId = nextIdNumber(existingIds);
  const entries = Object.entries(mapping).filter(
    (e): e is [string, NonNullable<UploadMappingEntry>] => e[1] !== null,
  );

  return rows.map((row, index) => {
    const input: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    let parseError: string | undefined;

    for (const [target, entry] of entries) {
      const dot = target.indexOf(".");
      const base = dot === -1 ? target : target.slice(0, dot);
      const name = dot === -1 ? "" : target.slice(dot + 1);
      if ((base !== "input" && base !== "expected") || name === "") continue;
      const cell = row[entry.column];
      if (cell === undefined || cell === "") continue;
      const schemaType = base === "input" ? schemaPropertyType(inputSchema, name) : undefined;
      const parsed = parseCell(cell, schemaType, entry.split, name);
      if ("error" in parsed) {
        parseError ??= parsed.error;
        continue;
      }
      (base === "input" ? input : expected)[name] = parsed.value;
    }

    const draft: DatasetCase = { id: "", input };
    if (Object.keys(expected).length > 0) draft.expected = expected;

    let reason = parseError;
    if (reason === undefined && inputSchema !== undefined) {
      try {
        reason = payloadInstanceMismatch(input, inputSchema);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    if (reason !== undefined) {
      return { index, case: draft, status: "skipped" as const, reason: trimReason(reason) };
    }
    draft.id = formatId(nextId);
    nextId += 1;
    return { index, case: draft, status: "ready" as const };
  });
}
