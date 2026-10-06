export function formatFindingLocation(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "—";
  return trimmed;
}
