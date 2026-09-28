import path from "node:path";
import { catalogContextFromStageflow } from "../config/resolveCatalogContext.js";
import { getCatalogScanPaths } from "../config/browseCatalog.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager, StartRunResult } from "./runManager.js";
import { findCatalogPathById, findTriggerDefinition } from "./triggerCatalog.js";

/**
 * Resolves a trigger id to its `*.trigger.yaml` catalog definition, resolves its
 * `pipeline`/`task` refs to catalog files, and starts a real run through
 * `RunManager.startRun` — the same internal entry point the CLI/MCP/console use.
 * On a successful start, records the fire on the trigger's store row.
 */
export async function fireTrigger(
  triggerId: string,
  store: RunStore,
  runManager: RunManager,
  options: { cwd?: string } = {},
): Promise<StartRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return { ok: false, reason: "No Stageflow catalog found", status: 404 };
  }

  const found = await findTriggerDefinition(scanPaths.triggerPaths, triggerId);
  if (!found) {
    return { ok: false, reason: `Trigger not found: ${triggerId}`, status: 404 };
  }
  const { path: triggerPath, definition: trigger } = found;

  if (!trigger.enabled) {
    return { ok: false, reason: `Trigger is disabled: ${triggerId}`, status: 409 };
  }

  const pipelinePath = await findCatalogPathById(scanPaths.pipelinePaths, trigger.pipeline);
  if (!pipelinePath) {
    return {
      ok: false,
      reason: `Trigger "${triggerId}" references unknown pipeline "${trigger.pipeline}"`,
      status: 400,
    };
  }
  const taskPath = await findCatalogPathById(scanPaths.taskPaths, trigger.task);
  if (!taskPath) {
    return {
      ok: false,
      reason: `Trigger "${triggerId}" references unknown task "${trigger.task}"`,
      status: 400,
    };
  }

  const projectRoot = ctx.projectRoot ?? undefined;
  const definitionRef =
    projectRoot !== undefined
      ? path.relative(projectRoot, triggerPath).replace(/\\/g, "/")
      : triggerPath;

  await store.upsertTrigger({
    id: triggerId,
    definitionRef,
    enabled: trigger.enabled,
  });

  const started = await runManager.startRun({
    pipeline: pipelinePath,
    task: taskPath,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  });

  if (started.ok) {
    await store.recordTriggerFired(triggerId, started.runId);
  }

  return started;
}
