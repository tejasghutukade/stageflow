import path from "node:path";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { loadTriggerOutcome } from "./loadTrigger.js";
import type { RunStore } from "../runstore/port.js";
import type { TriggerFile } from "../types/trigger.js";

export type TriggerListItem = TriggerFile & {
  definition_ref: string;
  last_fired_at?: string;
  last_run_id?: string;
  next_run_at?: string;
};

/** Catalog-authoritative trigger list, overlaid with each trigger's store-recorded fire state (if any). */
export async function loadCatalogTriggers(
  cwd: string,
  store: RunStore,
): Promise<TriggerListItem[] | undefined> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) return undefined;
  const projectRoot = ctx.projectRoot ?? undefined;

  const items: TriggerListItem[] = [];
  for (const filePath of scanPaths.triggerPaths) {
    const outcome = await loadTriggerOutcome(filePath);
    if (!outcome.ok) continue;
    const definitionRef =
      projectRoot !== undefined
        ? path.relative(projectRoot, filePath).replace(/\\/g, "/")
        : filePath;
    const record = await store.getTrigger(outcome.value.id);
    items.push({
      ...outcome.value,
      definition_ref: definitionRef,
      ...(record?.last_fired_at !== undefined
        ? { last_fired_at: record.last_fired_at }
        : {}),
      ...(record?.last_run_id !== undefined
        ? { last_run_id: record.last_run_id }
        : {}),
      ...(record?.next_run_at !== undefined
        ? { next_run_at: record.next_run_at }
        : {}),
    });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
