import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { RunStore } from "../runstore/port.js";
import { loadCatalogTriggers, type TriggerListItem } from "./triggerCatalog.js";
import { loadTriggerFromYamlOutcome } from "./loadTrigger.js";
import { findTriggerDefinition } from "../runtime/triggerCatalog.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

export type PatchTriggerInput = {
  enabled: boolean;
};

export type PatchTriggerParseError = {
  ok: false;
  status: 400;
  error: string;
};

export function parsePatchTriggerBody(
  body: unknown,
): PatchTriggerInput | PatchTriggerParseError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "enabled") {
    return {
      ok: false,
      status: 400,
      error: "Only enabled is allowed in the request body",
    };
  }
  if (typeof record.enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }
  return { enabled: record.enabled };
}

export type UpdateTriggerResult =
  | { ok: true; trigger: TriggerListItem }
  | { ok: false; status: 404 | 400 | 500; error: string };

export async function updateTriggerEnabled(
  cwd: string,
  store: RunStore,
  triggerId: string,
  enabled: boolean,
): Promise<UpdateTriggerResult> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return { ok: false, status: 404, error: "No Stageflow catalog found" };
  }

  const found = await findTriggerDefinition(scanPaths.triggerPaths, triggerId);
  if (!found) {
    return { ok: false, status: 404, error: `Trigger not found: ${triggerId}` };
  }

  const yamlText = await readFile(found.path, "utf8");
  const doc = parseDocument(yamlText);
  if (!doc.contents || typeof doc.contents !== "object") {
    return { ok: false, status: 500, error: "Trigger YAML must be an object" };
  }
  doc.set("enabled", enabled);
  const patched = doc.toString();
  const loadOutcome = loadTriggerFromYamlOutcome(patched, found.path);
  if (!loadOutcome.ok) {
    return {
      ok: false,
      status: 400,
      error: loadOutcome.issues[0]?.message ?? "Invalid trigger after patch",
    };
  }

  await writeFile(found.path, patched, "utf8");

  const projectRoot = ctx.projectRoot ?? undefined;
  const definitionRef =
    projectRoot !== undefined
      ? path.relative(projectRoot, found.path).replace(/\\/g, "/")
      : found.path;
  await store.upsertTrigger({
    id: loadOutcome.value.id,
    definitionRef,
    enabled: loadOutcome.value.enabled,
  });

  const items = await loadCatalogTriggers(cwd, store);
  const item = items?.find((row) => row.id === triggerId);
  if (!item) {
    return { ok: false, status: 500, error: "Trigger updated but not listed" };
  }
  return { ok: true, trigger: item };
}
