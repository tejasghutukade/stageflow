/** Kind names only, with no imports, so the console can type-check modules that list kinds without the Node graph. */
export const LIVE_DECLARATIVE_KIND = "live.declarative";
export const LIVE_HTML_KIND = "live.html";

export type StaticArtifactKind =
  | "static.markdown"
  | "static.image"
  | "static.table"
  | "static.text"
  | "static.html";
