import path from "node:path";
import { artifactMediaType } from "../runread/readArtifact.js";

export type StaticArtifactKind =
  | "static.markdown"
  | "static.image"
  | "static.table"
  | "static.text"
  | "static.html";

export function inferStaticKind(relativePath: string): StaticArtifactKind {
  const ext = path.posix.extname(relativePath.replace(/\\/g, "/")).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "static.markdown";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
      return "static.image";
    case ".csv":
    case ".json":
      return "static.table";
    case ".html":
    case ".htm":
      return "static.html";
    default:
      return "static.text";
  }
}

export function contentTypeForKind(kind: StaticArtifactKind, relativePath: string): string {
  switch (kind) {
    case "static.markdown":
      return "text/markdown";
    case "static.image":
      return artifactMediaType(relativePath) ?? "application/octet-stream";
    case "static.table":
      return relativePath.replace(/\\/g, "/").toLowerCase().endsWith(".csv")
        ? "text/csv"
        : "application/json";
    case "static.html":
      return "text/html; charset=utf-8";
    case "static.text":
      return "text/plain; charset=utf-8";
  }
}
