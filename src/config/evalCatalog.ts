import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import { scanCatalogPaths, type CatalogPathKind } from "./scanCatalogPaths.js";

export type CatalogFileRef = { absPath: string; relPath: string };

async function listFiles(
  manifest: LoadedManifest,
  kind: CatalogPathKind,
): Promise<CatalogFileRef[]> {
  const absPaths = await scanCatalogPaths(manifest, kind);
  return absPaths.map((absPath) => ({
    absPath,
    relPath: path.relative(manifest.projectRoot, absPath).split(path.sep).join("/"),
  }));
}

export function listEvalFiles(manifest: LoadedManifest): Promise<CatalogFileRef[]> {
  return listFiles(manifest, "eval");
}

export function listDatasetFiles(manifest: LoadedManifest): Promise<CatalogFileRef[]> {
  return listFiles(manifest, "dataset");
}
