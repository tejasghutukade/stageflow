import { CsvParseError, parseCsv } from "./csv";

export const TABLE_ROW_CAP = 500;

export type BuiltTable = {
  columns: string[];
  rows: string[][];
};

export type TableBuildResult =
  | { ok: true; table: BuiltTable }
  | { ok: false; reason: "invalid" | "empty" };

export function tableFromCsv(text: string): TableBuildResult {
  let parsed: string[][];
  try {
    parsed = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvParseError) return { ok: false, reason: "invalid" };
    throw error;
  }
  if (parsed.length === 0) return { ok: false, reason: "empty" };
  const width = parsed.reduce((max, row) => Math.max(max, row.length), 0);
  const header = parsed[0] ?? [];
  const columns = Array.from({ length: width }, (_, index) => {
    const name = header[index];
    return name !== undefined && name.length > 0 ? name : `Column ${index + 1}`;
  });
  const rows = parsed.slice(1).map((cells) =>
    Array.from({ length: width }, (_, index) => cells[index] ?? ""),
  );
  return { ok: true, table: { columns, rows } };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function tableFromJson(text: string): TableBuildResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!Array.isArray(value)) return { ok: false, reason: "invalid" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (!value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
    return { ok: false, reason: "invalid" };
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  const rows = value.map((row) =>
    columns.map((key) => cellText((row as Record<string, unknown>)[key])),
  );
  return { ok: true, table: { columns, rows } };
}

function compareCells(left: string, right: string): number {
  const a = left.trim();
  const b = right.trim();
  const aNum = Number(a);
  const bNum = Number(b);
  const aNumeric = a !== "" && Number.isFinite(aNum);
  const bNumeric = b !== "" && Number.isFinite(bNum);
  if (aNumeric && bNumeric && aNum !== bNum) return aNum < bNum ? -1 : 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type TableSort = { column: number; direction: "asc" | "desc" } | null;

/** First click sorts ascending, second descending, third returns to file order. */
export function nextTableSort(current: TableSort, column: number): TableSort {
  if (current?.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/** Stable sort. Ties keep the original row order. Numbers compare as numbers when both cells are numeric. */
export function sortTableRows(
  rows: readonly string[][],
  column: number,
  direction: "asc" | "desc",
): string[][] {
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((left, right) => {
    const cmp = compareCells(left.row[column] ?? "", right.row[column] ?? "");
    if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    return left.index - right.index;
  });
  return indexed.map((item) => item.row);
}

export function capTableRows(rows: readonly string[][]): { rows: string[][]; total: number; note: string | null } {
  const total = rows.length;
  if (total <= TABLE_ROW_CAP) return { rows: [...rows], total, note: null };
  return {
    rows: rows.slice(0, TABLE_ROW_CAP),
    total,
    note: `showing first ${TABLE_ROW_CAP} of ${total}`,
  };
}
