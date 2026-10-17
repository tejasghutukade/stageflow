import type { McpToolInfo } from "../../../api";

/** Tools to show: the server's, plus any already granted that the server no longer lists. */
export function toolRows(
  listed: readonly McpToolInfo[],
  granted: readonly string[],
): Array<McpToolInfo & { missing: boolean }> {
  const known = new Set(listed.map((tool) => tool.name));
  const extra = granted.filter((name) => name !== "*" && !known.has(name));
  return [
    ...listed.map((tool) => ({ ...tool, missing: false })),
    ...extra.map((name) => ({ name, missing: true })),
  ];
}

export function toggleTool(granted: readonly string[], name: string, on: boolean): string[] {
  const without = granted.filter((tool) => tool !== name);
  return on ? [...without, name] : without;
}

/** Tick or untick every tool in `names` (the rows currently shown), leaving the rest as they are. */
export function setMany(granted: readonly string[], names: readonly string[], on: boolean): string[] {
  const shown = new Set(names);
  const kept = granted.filter((tool) => !shown.has(tool));
  return on ? [...kept, ...names] : kept;
}

export function filterRows<T extends McpToolInfo>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) => row.name.toLowerCase().includes(q) || (row.description ?? "").toLowerCase().includes(q));
}
