import type { CatalogContext } from "./resolveCatalogContext.js";
import { listModelsForContext } from "./browseCatalog.js";

export async function listModelsFromManifest(ctx: CatalogContext): Promise<string[]> {
  return listModelsForContext(ctx);
}
