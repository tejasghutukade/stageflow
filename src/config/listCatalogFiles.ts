import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const CATALOG_FILE_LIST_MAX = 500;
export const CATALOG_WALK_MAX_ENTRIES = 20_000;
export const CATALOG_WALK_MAX_DIRECTORIES = 2_000;
export const CATALOG_WALK_TIME_BUDGET_MS = 2_000;
const MAX_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKey(entry: { name: string; isDirectory(): boolean }): string {
  return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

export function isListableExtension(ext: string): boolean {
  return /^\.[A-Za-z0-9]{1,16}$/.test(ext);
}

/**
 * Relative paths of regular files with the given extension under a catalog root, sorted. Symbolic links are
 * not followed, so nothing outside the root is listed. At most `CATALOG_FILE_LIST_MAX` paths are returned, and
 * the walk stops (`truncated: true`) after visiting too many entries or directories or running out of time.
 * The walk visits entries in path order, so a truncated list is the first paths of the full sorted list.
 */
export async function listCatalogFiles(
  rootPath: string,
  ext: string,
  limits: { maxEntries?: number; maxDirectories?: number; timeBudgetMs?: number } = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const maxEntries = limits.maxEntries ?? CATALOG_WALK_MAX_ENTRIES;
  const maxDirectories = limits.maxDirectories ?? CATALOG_WALK_MAX_DIRECTORIES;
  const deadline = Date.now() + (limits.timeBudgetMs ?? CATALOG_WALK_TIME_BUDGET_MS);
  const files: string[] = [];
  let truncated = false;
  let entriesSeen = 0;
  let directoriesSeen = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_DEPTH) return;
    if (directoriesSeen >= maxDirectories || Date.now() > deadline) {
      truncated = true;
      return;
    }
    directoriesSeen += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareText(sortKey(a), sortKey(b)));
    for (const entry of entries) {
      if (truncated) return;
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
        if (files.length >= CATALOG_FILE_LIST_MAX) {
          truncated = true;
          return;
        }
        files.push(path.relative(rootPath, full).replace(/\\/g, "/"));
      }
    }
  }

  const stat = await lstat(rootPath);
  if (stat.isDirectory()) await walk(rootPath, 0);
  files.sort(compareText);
  return { files, truncated };
}
