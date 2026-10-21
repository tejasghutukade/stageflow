import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readYamlObject } from "./readYamlObject.js";
import {
  canonicalCatalogBasenameForDocument,
  isMisnamedCatalogBasename,
  legacyBareCatalogFilenames,
  normalizePipelineCatalogFilename,
  normalizeTaskCatalogFilename,
  reconcileWorkshopCatalogFilenames,
  type WorkshopCatalogRepairResult,
} from "./workshopCatalogFilenames.js";

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function renameIfNeeded(
  fromAbs: string,
  toAbs: string,
  renamed: WorkshopCatalogRepairResult["renamed"],
): Promise<void> {
  if (fromAbs === toAbs) return;
  if (!(await fileExists(fromAbs))) return;
  if (await fileExists(toAbs)) {
    await rm(fromAbs, { force: true });
    return;
  }
  await rename(fromAbs, toAbs);
  renamed.push({
    from: path.basename(fromAbs),
    to: path.basename(toAbs),
  });
}

export async function repairMisnamedWorkshopCatalogFiles(
  packageDirectory: string,
): Promise<WorkshopCatalogRepairResult> {
  const renamed: WorkshopCatalogRepairResult["renamed"] = [];
  const removed: WorkshopCatalogRepairResult["removed"] = [];

  let entries: string[];
  try {
    entries = await readdir(packageDirectory);
  } catch {
    return { renamed, removed };
  }

  for (const entry of entries) {
    if (!isMisnamedCatalogBasename(entry)) continue;
    const absPath = path.join(packageDirectory, entry);
    let raw: Record<string, unknown>;
    try {
      raw = await readYamlObject(absPath);
    } catch {
      continue;
    }
    const canonical = canonicalCatalogBasenameForDocument(raw, entry);
    if (!canonical || canonical === entry) continue;
    const targetAbs = path.join(packageDirectory, canonical);
    await renameIfNeeded(absPath, targetAbs, renamed);
  }

  return { renamed, removed };
}

export async function reconcileWorkshopCatalogPackageDir(
  packageDirectory: string,
  pipelineId: string,
  taskId?: string | null,
  options?: {
    pipelineBasename?: string;
    taskBasename?: string | null;
  },
): Promise<WorkshopCatalogRepairResult> {
  const result = await repairMisnamedWorkshopCatalogFiles(packageDirectory);
  const pipelineBasename =
    options?.pipelineBasename?.trim() ||
    normalizePipelineCatalogFilename(pipelineId);
  const taskBasename = taskId?.trim()
    ? options?.taskBasename?.trim() ||
      normalizeTaskCatalogFilename(taskId)
    : null;

  for (const legacy of legacyBareCatalogFilenames(pipelineId)) {
    if (legacy === pipelineBasename) continue;
    const legacyAbs = path.join(packageDirectory, legacy);
    const canonicalAbs = path.join(packageDirectory, pipelineBasename);
    if (!(await fileExists(legacyAbs))) continue;
    if (!(await fileExists(canonicalAbs))) {
      let raw: Record<string, unknown>;
      try {
        raw = await readYamlObject(legacyAbs);
      } catch {
        continue;
      }
      if (canonicalCatalogBasenameForDocument(raw) === pipelineBasename) {
        await renameIfNeeded(legacyAbs, canonicalAbs, result.renamed);
        continue;
      }
    }
    if (await fileExists(canonicalAbs)) {
      await rm(legacyAbs, { force: true });
      result.removed.push(legacy);
    }
  }

  if (taskId?.trim() && taskBasename) {
    for (const legacy of legacyBareCatalogFilenames(taskId)) {
      if (legacy === taskBasename || legacy === pipelineBasename) continue;
      const legacyAbs = path.join(packageDirectory, legacy);
      const canonicalAbs = path.join(packageDirectory, taskBasename);
      if (!(await fileExists(legacyAbs))) continue;
      if (!(await fileExists(canonicalAbs))) {
        let raw: Record<string, unknown>;
        try {
          raw = await readYamlObject(legacyAbs);
        } catch {
          continue;
        }
        if (canonicalCatalogBasenameForDocument(raw) === taskBasename) {
          await renameIfNeeded(legacyAbs, canonicalAbs, result.renamed);
          continue;
        }
      }
      if (await fileExists(canonicalAbs)) {
        await rm(legacyAbs, { force: true });
        result.removed.push(legacy);
      }
    }
  }

  const { removeCandidates } = reconcileWorkshopCatalogFilenames(
    pipelineId,
    taskId,
    pipelineBasename,
    taskBasename,
  );
  for (const legacy of removeCandidates) {
    const legacyAbs = path.join(packageDirectory, legacy);
    const canonicalAbs = path.join(packageDirectory, pipelineBasename);
    if (!(await fileExists(legacyAbs))) continue;
    if (legacyAbs === canonicalAbs) continue;
    if (taskBasename && legacy === taskBasename) continue;
    if (!(await fileExists(canonicalAbs))) continue;
    await rm(legacyAbs, { force: true });
    result.removed.push(legacy);
  }

  return result;
}

export async function repairWorkshopCatalogTree(
  projectRoot: string,
  relativeDirectories: string[],
): Promise<WorkshopCatalogRepairResult> {
  const merged: WorkshopCatalogRepairResult = { renamed: [], removed: [] };
  for (const rel of relativeDirectories) {
    const dir = path.resolve(projectRoot, rel);
    const part = await repairMisnamedWorkshopCatalogFiles(dir);
    merged.renamed.push(...part.renamed);
    merged.removed.push(...part.removed);
  }
  return merged;
}
