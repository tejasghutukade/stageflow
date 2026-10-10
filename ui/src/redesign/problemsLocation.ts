export function formatFindingLocation(path: string, line?: number): string {
  const trimmed = path.trim();
  if (!trimmed) return "—";
  if (typeof line === "number" && Number.isFinite(line)) return `${trimmed}:${line}`;
  return trimmed;
}
