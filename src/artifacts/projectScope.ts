import { realpathSync } from "node:fs";
import path from "node:path";
import type { CatalogRoot } from "../config/resolveCatalogRoots.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import type { RunStore } from "../runstore/port.js";

export type CanonicalProject = {
  id: string;
  registered: boolean;
};

let extraRootsForTests: CatalogRoot[] = [];

export function setArtifactCatalogRootsForTests(roots: CatalogRoot[] | undefined): void {
  extraRootsForTests = roots ?? [];
}

export async function catalogRootsForArtifacts(store: RunStore): Promise<CatalogRoot[]> {
  const resolved = await resolveCatalogRoots({ store });
  if (extraRootsForTests.length === 0) return resolved;
  return [...resolved, ...extraRootsForTests];
}

function realOrResolve(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Map a stored run project value to one catalog wire id.
 * Absolute paths (HTTP), wire ids (CLI) and seeded ids match on real path.
 * A root that is no longer registered keeps the stored value.
 */
export function canonicalProjectWireId(stored: string, roots: readonly CatalogRoot[]): CanonicalProject {
  const trimmed = stored.trim();
  for (const root of roots) {
    if (root.project_root === trimmed) return { id: root.project_root, registered: true };
  }
  if (path.isAbsolute(trimmed)) {
    const storedReal = realOrResolve(trimmed);
    for (const root of roots) {
      if (realOrResolve(root.path) === storedReal) {
        return { id: root.project_root, registered: true };
      }
      if (path.isAbsolute(root.project_root) && realOrResolve(root.project_root) === storedReal) {
        return { id: root.project_root, registered: true };
      }
    }
  }
  return { id: trimmed, registered: false };
}
