import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";

export type CatalogPathKind = "pipeline" | "task";

function normalizeRepoRel(repoRelPath: string): string {
  return repoRelPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function isExcluded(repoRelPath: string, exclude: string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) {
    return false;
  }
  const normalized = normalizeRepoRel(repoRelPath);
  for (const entry of exclude) {
    const prefix = normalizeRepoRel(entry);
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(basename: string, pattern: string): boolean {
  return globPatternToRegExp(pattern).test(basename);
}

async function walkDirectory(absDir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true, recursive: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = entry.parentPath ?? absDir;
    files.push(path.join(parentDir, entry.name));
  }
  return files;
}

async function expandCatalogEntry(
  projectRoot: string,
  entry: string,
  kind: CatalogPathKind,
  pattern: string,
): Promise<string[]> {
  const absPath = path.join(projectRoot, entry);
  let entryStat;
  try {
    entryStat = await stat(absPath);
  } catch {
    return [];
  }

  if (entryStat.isFile()) {
    return [absPath];
  }

  if (!entryStat.isDirectory()) {
    return [];
  }

  const files = await walkDirectory(absPath);
  return files.filter((filePath) => matchesPattern(path.basename(filePath), pattern));
}

export async function scanCatalogPaths(
  manifest: LoadedManifest,
  kind: CatalogPathKind,
): Promise<string[]> {
  const { projectRoot, manifest: doc, patterns } = manifest;
  const entries = kind === "pipeline" ? doc.catalog.pipelines : doc.catalog.tasks;
  const pattern = kind === "pipeline" ? patterns.pipeline : patterns.task;
  const exclude = doc.catalog.exclude;

  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const entry of entries) {
    const absPaths = await expandCatalogEntry(projectRoot, entry, kind, pattern);
    for (const absPath of absPaths) {
      const normalized = path.resolve(absPath);
      if (seen.has(normalized)) continue;
      const repoRel = normalizeRepoRel(path.relative(projectRoot, normalized));
      if (isExcluded(repoRel, exclude)) continue;
      seen.add(normalized);
      resolved.push(normalized);
    }
  }

  resolved.sort((a, b) => a.localeCompare(b));
  return resolved;
}
