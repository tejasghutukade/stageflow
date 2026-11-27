import { HTML_LIBRARY_FLAGS } from "../../../../../src/artifacts/library/htmlLibraryFlags.ts";

export type LiveHtmlCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type LiveHtmlCspOptions = {
  libraryDirs?: string[];
  assetDirs?: string[];
  needsEval?: boolean;
  shellOrigin?: string;
};

function normalizeShellOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function policyList(values: readonly string[] | undefined, empty: string): string {
  const items = [...new Set(values ?? [])].sort();
  if (items.length === 0) return empty;
  return items.join(" ");
}

function knownDirectory(token: string, shellOrigin: string, assetsOnly: boolean): boolean {
  if (token.includes("?") || token.includes("#") || token.includes("\\") || !token.endsWith("/")) return false;
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return false;
  }
  if (url.search || url.hash || url.username || url.password) return false;
  const origin = `${url.protocol}//${url.host}`;
  const shell = normalizeShellOrigin(shellOrigin);
  if (!shell || origin !== shell) return false;
  if (!url.pathname.startsWith("/libs/") || !url.pathname.endsWith("/")) return false;
  const id = url.pathname.slice("/libs/".length, -1);
  if (!id || id.includes("/")) return false;
  const at = id.lastIndexOf("@");
  if (at <= 0) return false;
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  const library = HTML_LIBRARY_FLAGS.find((item) => item.name === name && item.version === version);
  if (!library) return false;
  if (token !== `${origin}/libs/${library.name}@${library.version}/`) return false;
  if (assetsOnly && !library.assets) return false;
  return true;
}

function acceptedDirs(values: readonly string[] | undefined, shellOrigin: string, assetsOnly: boolean): string[] {
  const dirs: string[] = [];
  for (const token of values ?? []) {
    if (!knownDirectory(token, shellOrigin, assetsOnly)) continue;
    if (!dirs.includes(token)) dirs.push(token);
  }
  dirs.sort();
  return dirs;
}

function policyParts(head: string, dirs: readonly string[], resources: string): string {
  return [head, ...dirs, resources].filter((part) => part.length > 0).join(" ");
}

export function libraryCspSources(
  shellOrigin: string,
  libraries: readonly { name: string; version: string }[],
): { libraryDirs: string[]; assetDirs: string[] } {
  if (!normalizeShellOrigin(shellOrigin)) return { libraryDirs: [], assetDirs: [] };
  const libraryDirs: string[] = [];
  const assetDirs: string[] = [];
  for (const ref of libraries) {
    const library = HTML_LIBRARY_FLAGS.find((item) => item.name === ref.name && item.version === ref.version);
    if (!library) continue;
    const dir = `${shellOrigin}/libs/${library.name}@${library.version}/`;
    if (!libraryDirs.includes(dir)) libraryDirs.push(dir);
    if (library.assets && !assetDirs.includes(dir)) assetDirs.push(dir);
  }
  libraryDirs.sort();
  assetDirs.sort();
  return { libraryDirs, assetDirs };
}

/** Same policy string as `buildHtmlCsp` / `artifactDocumentCsp`. Those modules import Node. */
export function liveHtmlDocumentCsp(csp: LiveHtmlCsp, options: LiveHtmlCspOptions = {}): string {
  const resource = policyList(csp.resourceDomains, "");
  const shellOrigin = options.shellOrigin ?? "";
  const libraryDirs = acceptedDirs(options.libraryDirs, shellOrigin, false);
  const assetDirs = acceptedDirs(options.assetDirs, shellOrigin, true);
  const scriptHead = options.needsEval && libraryDirs.length > 0 ? "'unsafe-inline' 'unsafe-eval'" : "'unsafe-inline'";
  return [
    "default-src 'none'",
    `script-src ${policyParts(scriptHead, libraryDirs, resource)}`,
    `style-src ${policyParts("'unsafe-inline'", libraryDirs, resource)}`,
    `img-src ${policyParts("data:", assetDirs, resource)}`,
    `font-src ${policyParts("data:", assetDirs, resource)}`,
    `media-src ${policyParts("data:", [], resource)}`,
    `connect-src ${policyList(csp.connectDomains, "'none'")}`,
    "frame-src 'none'",
    `base-uri ${policyList(csp.baseUriDomains, "'none'")}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}
