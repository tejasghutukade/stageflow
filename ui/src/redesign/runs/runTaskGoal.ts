export function runGoalFromTaskYaml(taskYaml: string | undefined): string | null {
  if (!taskYaml?.trim()) return null;
  for (const line of taskYaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^goal:\s*(.+)$/i.exec(trimmed);
    if (!match) continue;
    const raw = match[1].trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1).trim() || null;
    }
    return raw || null;
  }
  return null;
}
