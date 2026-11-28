import type { CatalogRoot } from "../../api/types";

export type HiddenInProject = { root: string; label: string; count: number };

/**
 * Items a project-scoped list leaves out, per other project. `keyOf` must identify an item well enough
 * that the same project listed through another root address yields the same keys (so it counts zero).
 */
export async function countHiddenInOtherProjects<T>(input: {
  roots: readonly CatalogRoot[];
  visible: readonly T[];
  load: (root: string) => Promise<readonly T[]>;
  keyOf: (item: T) => string;
  scope?: string | undefined;
}): Promise<HiddenInProject[]> {
  const seen = new Set(input.visible.map(input.keyOf));
  const candidates = input.roots.filter((r) => r.available && r.project_root !== input.scope);
  const results = await Promise.all(
    candidates.map(async (root) => {
      const items = await input.load(root.project_root).catch(() => [] as readonly T[]);
      const count = items.filter((item) => !seen.has(input.keyOf(item))).length;
      return { root: root.project_root, label: root.label, count };
    }),
  );
  return results.filter((r) => r.count > 0);
}

export function hiddenTotal(hidden: readonly HiddenInProject[]): number {
  return hidden.reduce((sum, h) => sum + h.count, 0);
}

export function hiddenSummary(hidden: readonly HiddenInProject[]): string {
  const total = hiddenTotal(hidden);
  return `${total} more in other projects`;
}
