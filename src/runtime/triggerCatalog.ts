import { readYamlObject } from "../config/readYamlObject.js";
import { loadTriggerOutcome } from "../config/loadTrigger.js";
import type { TriggerFile } from "../types/trigger.js";

export async function findCatalogPathById(
  paths: string[],
  id: string,
): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      const raw = await readYamlObject(filePath);
      if (raw?.id === id) return filePath;
    } catch {
      // Unreadable/invalid catalog files are surfaced by `sf validate`; skip here.
    }
  }
  return undefined;
}

export async function findTriggerDefinition(
  triggerPaths: string[],
  triggerId: string,
): Promise<{ path: string; definition: TriggerFile } | undefined> {
  for (const filePath of triggerPaths) {
    const outcome = await loadTriggerOutcome(filePath);
    if (outcome.ok && outcome.value.id === triggerId) {
      return { path: filePath, definition: outcome.value };
    }
  }
  return undefined;
}
