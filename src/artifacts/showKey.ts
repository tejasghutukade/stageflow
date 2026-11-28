export function parseArtifactShowKey(key: string): { ownerKey: string; id: string } | undefined {
  const trimmed = key.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { ownerKey: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}
