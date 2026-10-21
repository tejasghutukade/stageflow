import path from "node:path";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { loadStageflowManifestOutcome } from "./loadStageflowManifest.js";
import { loadTriggerOutcome } from "./loadTrigger.js";
import type { CatalogContext } from "./resolveCatalogContext.js";
import {
  isRootReadable,
  resolveCatalogRoots,
  findCatalogRoot,
  type CatalogRoot,
  type ResolveCatalogRootsOptions,
} from "./resolveCatalogRoots.js";
import type { RunStore } from "../runstore/port.js";
import type { TriggerFile } from "../types/trigger.js";
import type { TriggerRecord } from "../runstore/port.js";

export type TriggerListItem = TriggerFile & {
  definition_ref: string;
  project_root: string;
  last_fired_at?: string;
  last_run_id?: string;
  next_run_at?: string;
};

export type CatalogTriggerMatch = {
  definition: TriggerFile;
  path: string;
  project_root: string;
  rootPath: string;
  definition_ref: string;
};

const TRIGGER_STORE_SEP = "::";

/** Store row id namespaced by catalog wire root so two roots can share a trigger id. */
export function triggerStoreId(wireProjectRoot: string, catalogId: string): string {
  return `${wireProjectRoot}${TRIGGER_STORE_SEP}${catalogId}`;
}

export async function readTriggerStoreRecord(
  store: RunStore,
  wireProjectRoot: string,
  catalogId: string,
): Promise<TriggerRecord | null> {
  const namespaced = await store.getTrigger(triggerStoreId(wireProjectRoot, catalogId));
  if (namespaced) return namespaced;
  return store.getTrigger(catalogId);
}

async function catalogContextForRoot(root: CatalogRoot): Promise<CatalogContext | null> {
  const outcome = await loadStageflowManifestOutcome(root.path);
  if (!outcome.ok) return null;
  return {
    projectRoot: root.path,
    manifest: outcome.value,
    manifestStatus: "ok",
    issues: [],
  };
}

async function triggersInRoot(root: CatalogRoot): Promise<CatalogTriggerMatch[]> {
  if (root.available === false) return [];
  if (!(await isRootReadable(root.path))) return [];
  const ctx = await catalogContextForRoot(root);
  if (!ctx) return [];
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) return [];

  const matches: CatalogTriggerMatch[] = [];
  for (const filePath of scanPaths.triggerPaths) {
    const outcome = await loadTriggerOutcome(filePath);
    if (!outcome.ok) continue;
    matches.push({
      definition: outcome.value,
      path: filePath,
      project_root: root.project_root,
      rootPath: root.path,
      definition_ref: path.relative(root.path, filePath).replace(/\\/g, "/"),
    });
  }
  return matches;
}

export async function listCatalogTriggerMatches(
  options: ResolveCatalogRootsOptions & { sourceRootsOnly?: boolean },
): Promise<CatalogTriggerMatch[]> {
  const roots = await resolveCatalogRoots(options);
  const selected = options.sourceRootsOnly
    ? roots.filter((r) => r.kind !== "seeded")
    : roots;
  const matches: CatalogTriggerMatch[] = [];
  for (const root of selected) {
    matches.push(...(await triggersInRoot(root)));
  }
  return matches;
}

export type FindCatalogTriggerResult =
  | { ok: true; match: CatalogTriggerMatch }
  | { ok: false; status: 404; reason: string }
  | {
      ok: false;
      status: 409;
      reason: string;
      code: "ambiguous_trigger";
      project_roots: string[];
    }
  | {
      ok: false;
      status: 400;
      reason: string;
      code: "unknown_project_root";
    };

export async function findCatalogTrigger(
  options: ResolveCatalogRootsOptions & {
    triggerId: string;
    projectRootFilter?: string;
  },
): Promise<FindCatalogTriggerResult> {
  const roots = await resolveCatalogRoots(options);
  if (options.projectRootFilter !== undefined) {
    const match = findCatalogRoot(roots, options.projectRootFilter);
    if (match === undefined) {
      return {
        ok: false,
        status: 400,
        reason: `Unknown project_root: ${options.projectRootFilter}`,
        code: "unknown_project_root",
      };
    }
    const inRoot = await triggersInRoot(match);
    const found = inRoot.find((t) => t.definition.id === options.triggerId);
    if (!found) {
      return { ok: false, status: 404, reason: `Trigger not found: ${options.triggerId}` };
    }
    return { ok: true, match: found };
  }

  const all = await listCatalogTriggerMatches(options);
  const matches = all.filter((m) => m.definition.id === options.triggerId);
  if (matches.length === 0) {
    return { ok: false, status: 404, reason: `Trigger not found: ${options.triggerId}` };
  }
  const projectRoots = [...new Set(matches.map((m) => m.project_root))];
  if (projectRoots.length > 1) {
    return {
      ok: false,
      status: 409,
      reason: `Trigger id is ambiguous across catalog roots: ${options.triggerId}`,
      code: "ambiguous_trigger",
      project_roots: projectRoots.sort((a, b) => a.localeCompare(b)),
    };
  }
  return { ok: true, match: matches[0]! };
}

/** Catalog-authoritative trigger list across all roots, overlaid with store fire state. */
export async function loadCatalogTriggers(
  options: ResolveCatalogRootsOptions,
): Promise<TriggerListItem[]> {
  const matches = await listCatalogTriggerMatches(options);
  const store = options.store;
  const items: TriggerListItem[] = [];
  for (const match of matches) {
    const record = await readTriggerStoreRecord(
      store,
      match.project_root,
      match.definition.id,
    );
    items.push({
      ...match.definition,
      project_root: match.project_root,
      definition_ref: match.definition_ref,
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
  return items.sort((a, b) => {
    const rootCmp = a.project_root.localeCompare(b.project_root);
    if (rootCmp !== 0) return rootCmp;
    return a.id.localeCompare(b.id);
  });
}
