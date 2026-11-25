import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHtmlLibrary, type HtmlLibrary, type HtmlLibraryFile } from "./htmlLibraries.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function htmlLibraryPackageRoot(): string {
  return packageRoot;
}

export function htmlLibraryContentType(filePath: string): string {
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function resolveHtmlLibraryFile(library: HtmlLibrary, file: HtmlLibraryFile): string | null {
  const vendored = path.join(packageRoot, "dist", "sandbox-libs", `${library.name}@${library.version}`, file.path);
  if (existsSync(vendored)) return vendored;
  const unpacked = path.join(packageRoot, "node_modules", library.packageName, file.packageFile);
  if (existsSync(unpacked)) return unpacked;
  return null;
}

const LIBRARY_CACHE_CAP_BYTES = 16 * 1024 * 1024;

const libraryCache = new Map<string, { body: Buffer; contentType: string }>();
let libraryCacheBytes = 0;
let libraryDiskReads = 0;

export function resetHtmlLibraryFileCacheForTests(): void {
  libraryCache.clear();
  libraryCacheBytes = 0;
  libraryDiskReads = 0;
}

export function htmlLibraryDiskReadsForTests(): number {
  return libraryDiskReads;
}

export function readHtmlLibraryFile(name: string, version: string, filePath: string): { body: Buffer; contentType: string } | null {
  const key = `${name}@${version}/${filePath}`;
  const cached = libraryCache.get(key);
  if (cached) return cached;
  const library = findHtmlLibrary(name, version);
  if (!library) return null;
  const file = library.files.find((entry) => entry.path === filePath);
  if (!file) return null;
  const resolved = resolveHtmlLibraryFile(library, file);
  if (!resolved) return null;
  libraryDiskReads += 1;
  const body = readFileSync(resolved);
  const result = { body, contentType: htmlLibraryContentType(file.path) };
  if (libraryCacheBytes + body.length <= LIBRARY_CACHE_CAP_BYTES) {
    libraryCache.set(key, result);
    libraryCacheBytes += body.length;
  }
  return result;
}

export function htmlLibraryIntegrity(bytes: Buffer): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}
