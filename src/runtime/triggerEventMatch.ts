/** Subset-match: every key/value in `match` must equal-match `payload`. No `match` matches everything. */
export function matchesEventFilter(
  match: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!match) return true;
  return Object.entries(match).every(([key, value]) => payload[key] === value);
}
