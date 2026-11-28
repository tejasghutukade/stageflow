import { useEffect, useState } from "react";
import { fetchCatalogRoots } from "../../api";
import type { CatalogRoot } from "../../api/types";
import { countHiddenInOtherProjects, type HiddenInProject } from "./otherProjects";

export function useHiddenInOtherProjects<T>(input: {
  enabled: boolean;
  visible: readonly T[];
  load: (root: string) => Promise<readonly T[]>;
  keyOf: (item: T) => string;
  scope: string | undefined;
}): { hidden: HiddenInProject[]; roots: CatalogRoot[] } {
  const [hidden, setHidden] = useState<HiddenInProject[]>([]);
  const [roots, setRoots] = useState<CatalogRoot[]>([]);
  const { enabled, visible, load, keyOf, scope } = input;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void (async () => {
      const catalog = await fetchCatalogRoots().catch(() => ({ roots: [] as CatalogRoot[] }));
      const counted = await countHiddenInOtherProjects({ roots: catalog.roots, visible, load, keyOf, scope });
      if (!live) return;
      setRoots(catalog.roots);
      setHidden(counted);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, visible, scope]);
  return { hidden, roots };
}
