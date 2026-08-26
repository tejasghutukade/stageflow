import path from "node:path";

export function normalizeCatalogPath(raw: string): string {
  return path.resolve(raw);
}
