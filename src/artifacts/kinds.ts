import path from "node:path";
import { artifactMediaType } from "../runread/readArtifact.js";

import { LIVE_DECLARATIVE_KIND, LIVE_HTML_KIND, type StaticArtifactKind } from "./kindNames.js";

export { LIVE_DECLARATIVE_KIND, LIVE_HTML_KIND, type StaticArtifactKind } from "./kindNames.js";

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

export function isLiveDeclarativeKind(kind: string): boolean {
  return kind === LIVE_DECLARATIVE_KIND;
}

export function isLiveHtmlKind(kind: string): boolean {
  return kind === LIVE_HTML_KIND;
}

export function isLiveKind(kind: string): boolean {
  return kind === LIVE_DECLARATIVE_KIND || kind === LIVE_HTML_KIND;
}

export function contentTypeForKind(kind: string, relativePath: string): string {
  if (kind === LIVE_DECLARATIVE_KIND) return "application/vnd.stageflow.openui";
  if (kind === LIVE_HTML_KIND) return "text/html; charset=utf-8";
  switch (kind as StaticArtifactKind) {
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
    default:
      return "application/octet-stream";
  }
}
