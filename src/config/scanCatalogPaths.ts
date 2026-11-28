import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";

export type CatalogPathKind = "pipeline" | "task" | "trigger" | "eval" | "dataset";

const TRANSIENT_FS_CODES = new Set([
  "ENOENT",
  "EBUSY",
  "EAGAIN",
  "EPERM",
  "EACCES",
  "EMFILE",
  "ENFILE",
  "EIO",
  "ETIMEDOUT",
  "EWOULDBLOCK",
  "UNKNOWN",
  "EBADF",
]);

function fsCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

async function retryTransient<T>(read: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const code = fsCode(error);
      if (code && TRANSIENT_FS_CODES.has(code) && attempt === 0) continue;
      return undefined;
    }
  }
  return undefined;
}

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
  const entries = await retryTransient(() => readdir(absDir, { withFileTypes: true, recursive: true }));
  if (!entries) return files;

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
  patterns: string[],
): Promise<string[]> {
  const absPath = path.join(projectRoot, entry);
  const entryStat = await retryTransient(() => stat(absPath));
  if (!entryStat) return [];

  if (entryStat.isFile()) {
    return [absPath];
  }

  if (!entryStat.isDirectory()) {
    return [];
  }

  const files = await walkDirectory(absPath);
  return files.filter((filePath) =>
    patterns.some((pattern) => matchesPattern(path.basename(filePath), pattern)),
  );
}

export async function scanCatalogPaths(
  manifest: LoadedManifest,
  kind: CatalogPathKind,
): Promise<string[]> {
  const { projectRoot, manifest: doc, patterns } = manifest;
  const entries =
    kind === "pipeline"
      ? doc.catalog.pipelines
      : kind === "task"
        ? doc.catalog.tasks
        : kind === "trigger"
          ? (doc.catalog.triggers ?? [])
          : kind === "eval"
            ? (doc.catalog.evals ?? ["evals"])
            : (doc.catalog.datasets ?? ["datasets"]);
  const matchPatterns =
    kind === "pipeline"
      ? [patterns.pipeline]
      : kind === "task"
        ? [patterns.task]
        : kind === "trigger"
          ? [patterns.trigger]
          : kind === "eval"
            ? [patterns.eval]
            : patterns.dataset;
  const exclude = doc.catalog.exclude;

  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const entry of entries) {
    const absPaths = await expandCatalogEntry(projectRoot, entry, matchPatterns);
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
