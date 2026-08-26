import type { CatalogContext } from "./resolveCatalogContext.js";
import { loadPipeline } from "./loadPipeline.js";
import { scanCatalogPaths } from "./scanCatalogPaths.js";

const BAKED_MODEL_IDS = [
  "anthropic/claude-sonnet-4-5",
  "cursor/auto",
  "cursor/composer-2-5",
] as const;

export async function listModelsFromManifest(ctx: CatalogContext): Promise<string[]> {
  const models = new Set<string>(BAKED_MODEL_IDS);
  if (ctx.manifestStatus !== "ok" || !ctx.projectRoot || !ctx.manifest) {
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  const filePaths = await scanCatalogPaths(ctx.manifest, "pipeline");
  for (const filePath of filePaths) {
    try {
      const loaded = await loadPipeline(filePath, { cwd: ctx.projectRoot });
      for (const stage of loaded.stages) {
        if (stage.model.trim()) {
          models.add(stage.model);
        }
      }
    } catch {
      // skip invalid pipelines
    }
  }

  return [...models].sort((a, b) => a.localeCompare(b));
}
