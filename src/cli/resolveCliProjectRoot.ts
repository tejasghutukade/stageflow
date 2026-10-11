import path from "node:path";
import { findCatalogRoot, resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import type { RunStore } from "../runstore/port.js";
import {
  WORKSPACE_CATALOG_ID,
  workspaceCatalogPath,
} from "../project/workspaceCatalog.js";

export type ResolvedCliProjectRoot = {
  rootPath: string;
  wireId: string;
};

export function resolveCliProjectRootLocal(flag: string): ResolvedCliProjectRoot | null {
  const trimmed = flag.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === WORKSPACE_CATALOG_ID) {
    return { rootPath: workspaceCatalogPath(), wireId: WORKSPACE_CATALOG_ID };
  }
  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    return { rootPath: resolved, wireId: resolved };
  }
  return null;
}

export async function resolveCliProjectRoot(
  flag: string,
  store: RunStore,
): Promise<ResolvedCliProjectRoot> {
  const local = resolveCliProjectRootLocal(flag);
  if (local) return local;
  const roots = await resolveCatalogRoots({ store });
  const found = findCatalogRoot(roots, flag.trim());
  if (found === undefined) {
    throw new Error(`Unknown project_root: ${flag.trim()}`);
  }
  return { rootPath: found.path, wireId: found.project_root };
}
