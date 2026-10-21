import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import { CatalogPathError, isInsideProjectRoot } from "./catalogRelativePath.js";
import { normalizeCatalogDir } from "./ensureCatalogScanRoot.js";
import { listDatasetFiles, listEvalFiles, type CatalogFileRef } from "./evalCatalog.js";
import { datasetFormatFromPath } from "./loadDataset.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
  parseStageflowManifestOutcome,
} from "./loadStageflowManifest.js";

export type WriteRootKind = "evals" | "datasets" | "pipelines";

const DEFAULT_DIR: Record<WriteRootKind, string> = {
  evals: "evals",
  datasets: "datasets",
  pipelines: "pipelines",
};

export async function manifestForWrite(projectRoot: string): Promise<LoadedManifest> {
  const outcome = await loadStageflowManifestOutcome(projectRoot);
  if (outcome.ok) return outcome.value;
  const fallback = parseStageflowManifestOutcome(
    "version: 1\ncatalog:\n  pipelines: [pipelines]\n  tasks: [tasks]\n",
    manifestPathForProject(projectRoot),
    projectRoot,
  );
  if (!fallback.ok) throw new Error("default manifest failed to parse");
  return fallback.value;
}

export function explicitRoots(manifest: LoadedManifest, kind: WriteRootKind): string[] | undefined {
  const entries = manifest.manifest.catalog[kind];
  return entries === undefined ? undefined : entries.map(normalizeCatalogDir);
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

function containedInProject(projectRoot: string, absPath: string): boolean {
  let realRoot = path.resolve(projectRoot);
  try {
    realRoot = realpathSync(realRoot);
  } catch {
    // project root missing: fall back to the resolved path
  }
  const rel = path.relative(path.resolve(projectRoot), absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return isInsideProjectRoot(projectRoot, path.resolve(realRoot, rel));
}

export type WriteDir = { absDir: string; relDir: string; explicitDirectory: boolean };

export async function resolveWriteDir(
  projectRoot: string,
  manifest: LoadedManifest,
  kind: WriteRootKind,
  directory?: string,
): Promise<WriteDir> {
  let relDir: string;
  if (directory !== undefined) {
    if (path.isAbsolute(directory)) {
      throw new CatalogPathError(
        "Absolute directory is not allowed; use a path relative to the project root",
        "absolute_path_not_allowed",
        [projectRoot],
      );
    }
    relDir = normalizeCatalogDir(directory) || ".";
  } else {
    relDir = DEFAULT_DIR[kind];
    for (const entry of explicitRoots(manifest, kind) ?? []) {
      if (!(await isFile(path.join(projectRoot, entry)))) {
        relDir = entry;
        break;
      }
    }
  }
  const absDir = path.resolve(projectRoot, relDir);
  if (!containedInProject(projectRoot, absDir)) {
    throw new CatalogPathError(
      `directory escapes project root ${projectRoot}`,
      "path_outside_project_root",
      [projectRoot],
    );
  }
  return { absDir, relDir, explicitDirectory: directory !== undefined };
}

export function assertInsideProject(projectRoot: string, absPath: string, what: string): void {
  if (!containedInProject(projectRoot, absPath)) {
    throw new CatalogPathError(`${what} escapes project root ${projectRoot}`, "path_outside_project_root", [
      projectRoot,
    ]);
  }
}

export function evalStem(fileName: string): string {
  return fileName.replace(/\.eval\.ya?ml$/, "");
}

export function datasetStem(fileName: string): string {
  return fileName.replace(/\.dataset\.(jsonl|json|csv)$/, "");
}

export async function findEvalFile(
  projectRoot: string,
  id: string,
  manifest?: LoadedManifest,
): Promise<CatalogFileRef | undefined> {
  const m = manifest ?? (await manifestForWrite(projectRoot));
  const refs = await listEvalFiles(m);
  return refs.find((ref) => evalStem(path.basename(ref.absPath)) === id);
}

export function datasetIdsFor(refs: readonly CatalogFileRef[]): Map<string, string> {
  const byStem = new Map<string, CatalogFileRef[]>();
  for (const ref of refs) {
    const stem = datasetStem(path.basename(ref.absPath));
    byStem.set(stem, [...(byStem.get(stem) ?? []), ref]);
  }
  const ids = new Map<string, string>();
  for (const [stem, group] of byStem) {
    for (const ref of group) {
      const format = datasetFormatFromPath(ref.absPath);
      ids.set(ref.absPath, group.length > 1 && format !== "jsonl" ? `${stem}.${format ?? "unknown"}` : stem);
    }
  }
  return ids;
}

export async function findDatasetFile(
  projectRoot: string,
  id: string,
  manifest?: LoadedManifest,
): Promise<CatalogFileRef | undefined> {
  const m = manifest ?? (await manifestForWrite(projectRoot));
  const refs = await listDatasetFiles(m);
  const ids = datasetIdsFor(refs);
  return refs.find((ref) => ids.get(ref.absPath) === id);
}
