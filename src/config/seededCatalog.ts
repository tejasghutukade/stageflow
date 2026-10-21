import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** Symbolic wire id for the packaged examples catalog root. */
export const SEEDED_EXAMPLES_ID = "examples";

/**
 * Absolute path to packaged `examples/` when present next to the package root.
 * Does not git-init; callers build CatalogContext with fixed projectRoot + manifest.
 */
export function resolveSeededExamplesPath(
  fromUrl: string = import.meta.url,
): string | undefined {
  const here = path.dirname(fileURLToPath(fromUrl));
  const candidates = [
    path.resolve(here, "../../examples"),
    path.resolve(here, "../../../examples"),
    path.resolve(process.cwd(), "examples"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "README.md"))) {
      return candidate;
    }
  }
  return undefined;
}

export function defaultSeededRoots(): Array<{ id: string; path: string }> {
  const examples = resolveSeededExamplesPath();
  if (examples === undefined) return [];
  return [{ id: SEEDED_EXAMPLES_ID, path: examples }];
}
