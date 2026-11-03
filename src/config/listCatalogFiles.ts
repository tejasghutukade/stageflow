import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const CATALOG_FILE_LIST_MAX = 500;
const MAX_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

export function isListableExtension(ext: string): boolean {
  return /^\.[A-Za-z0-9]{1,16}$/.test(ext);
}

/**
 * Relative paths of regular files with the given extension under a catalog root, sorted. Symbolic links are
 * not followed, so nothing outside the root is listed. At most `CATALOG_FILE_LIST_MAX` paths are returned.
 */
export async function listCatalogFiles(
  rootPath: string,
  ext: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
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
  files.sort();
  return { files, truncated };
}
