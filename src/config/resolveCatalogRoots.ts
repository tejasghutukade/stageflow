import path from "node:path";
import { realpathSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import type { RunStore } from "../runstore/port.js";

export type CatalogRootKind = "registered" | "seeded";

export type CatalogRoot = {
  /** Wire id: absolute path for registered; symbolic id for seeded (e.g. "examples"). */
  project_root: string;
  /** Absolute filesystem path used for browsing. */
  path: string;
  kind: CatalogRootKind;
  read_only: boolean;
};

export type ResolveCatalogRootsOptions = {
  store: RunStore;
  /** Unused for catalog membership; retained so call sites may still pass Host cwd. */
  bootCwd?: string;
  /** Optional seeded roots (U10); default none. */
  seededRoots?: Array<{ id: string; path: string }>;
};

function realOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Root set = registered store roots ∪ seeded roots.
 * Wire project_root for seeded is the symbolic id; store/capacity use absolute paths.
 */
export async function resolveCatalogRoots(
  options: ResolveCatalogRootsOptions,
): Promise<CatalogRoot[]> {
  const roots: CatalogRoot[] = [];
  const seenPaths = new Set<string>();
  const seededRoots =
    options.seededRoots ??
    (await import("./seededCatalog.js")).defaultSeededRoots();

  let registered: string[] = [];
  try {
    registered = await options.store.listRegisteredProjects();
  } catch {
    registered = [];
  }
  for (const root of registered) {
    const abs = realOrResolve(root);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    roots.push({
      project_root: abs,
      path: abs,
      kind: "registered",
      read_only: false,
    });
  }

  for (const seeded of seededRoots) {
    const abs = realOrResolve(seeded.path);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    roots.push({
      project_root: seeded.id,
      path: abs,
      kind: "seeded",
      read_only: true,
    });
  }

  return roots;
}

export async function isRootReadable(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCatalogRoot(
  roots: CatalogRoot[],
  projectRoot: string,
): CatalogRoot | undefined {
  if (!path.isAbsolute(projectRoot)) {
    return roots.find((r) => r.project_root === projectRoot);
  }
  const normalized = realOrResolve(projectRoot);
  const resolved = path.resolve(projectRoot);
  return roots.find(
    (r) =>
      r.project_root === projectRoot ||
      r.path === projectRoot ||
      r.project_root === resolved ||
      r.path === resolved ||
      r.project_root === normalized ||
      r.path === normalized,
  );
}
