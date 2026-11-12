import type { FunctionKind, FunctionSummary } from "../../api/functions";

export type FunctionDirectoryKind = "all" | FunctionKind;

export function filterFunctions(rows: readonly FunctionSummary[], kind: FunctionDirectoryKind): FunctionSummary[] {
  if (kind === "all") return [...rows];
  return rows.filter((row) => row.kind === kind);
}

export function searchFunctions(rows: readonly FunctionSummary[], query: string): FunctionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.name ?? "", row.id, row.description ?? ""].some((text) => text.toLowerCase().includes(needle)),
  );
}

export function kindCounts(rows: readonly FunctionSummary[]): Record<FunctionDirectoryKind, number> {
  return {
    all: rows.length,
    verification: rows.filter((row) => row.kind === "verification").length,
    routing: rows.filter((row) => row.kind === "routing").length,
    tool: rows.filter((row) => row.kind === "tool").length,
  };
}
