export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export function addRunsLabel(count: number): string {
  return count === 0 ? "Add cases" : `Add ${count} ${count === 1 ? "case" : "cases"}`;
}
