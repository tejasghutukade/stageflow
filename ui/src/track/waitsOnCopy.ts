export function waitsOnCopy(
  blockedBy: readonly string[],
  label: (stageId: string) => string,
): string {
  if (blockedBy.length === 0) return "waits on upstream";
  return `waits on ${blockedBy.map(label).join(", ")}`;
}
