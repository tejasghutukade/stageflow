import path from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { RunStore } from "../runstore/port.js";

export type CatalogRootKind = "boot" | "registered" | "seeded";

export type CatalogRoot = {
  /** Wire id: absolute path for boot/registered; symbolic id for seeded (e.g. "examples"). */
  project_root: string;
  /** Absolute filesystem path used for browsing. */
  path: string;
  kind: CatalogRootKind;
  read_only: boolean;
};

export type ResolveCatalogRootsOptions = {
  store: RunStore;
  bootCwd: string;
  /** Optional seeded roots (U10); default none. */
  seededRoots?: Array<{ id: string; path: string }>;
};

/**
 * Root set = registered store roots ∪ boot cwd ∪ seeded roots.
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

  const bootAbs = path.resolve(options.bootCwd);
  roots.push({
    project_root: bootAbs,
    path: bootAbs,
    kind: "boot",
    read_only: false,
  });
  seenPaths.add(bootAbs);

  let registered: string[] = [];
  try {
    registered = await options.store.listProjectRoots();
  } catch {
    registered = [];
  }
  for (const root of registered) {
    const abs = path.resolve(root);
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
    const abs = path.resolve(seeded.path);
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
  return roots.find(
    (r) => r.project_root === projectRoot || r.path === path.resolve(projectRoot),
  );
}
