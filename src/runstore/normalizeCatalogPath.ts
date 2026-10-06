import { realpathSync } from "node:fs";
import path from "node:path";

export function normalizeCatalogPath(raw: string): string {
  return path.resolve(raw);
}

export function normalizeProjectRoot(raw: string): string {
  const resolved = path.resolve(raw);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
