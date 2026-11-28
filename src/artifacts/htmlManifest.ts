import { createHash } from "node:crypto";
import { canonicalJson } from "../evals/canonical.js";
import { LIVE_HTML_KIND } from "./kinds.js";
import {
  HTML_LIBRARY_MAX,
  artifactEvalLibsAllowed,
  findHtmlLibrary,
  htmlLibraryCatalogIds,
  htmlLibraryId,
  type HtmlLibraryRef,
} from "./library/htmlLibraries.js";
import {
  HTML_CSP_HOST_MAX,
  HTML_CSP_LIST_MAX,
  ArtifactPublishError,
  type ArtifactIssue,
} from "./limits.js";
import {
  collectLiveBindings,
  collectLiveRefresh,
  parseStoredLiveManifest,
  type LiveBindingSet,
} from "./manifest.js";

export type HtmlCspListName = "connectDomains" | "resourceDomains" | "frameDomains" | "baseUriDomains";

export type HtmlCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type HtmlManifest = LiveBindingSet & {
  format: "html";
  csp: HtmlCsp;
  libraries?: HtmlLibraryRef[];
};

export type ValidateHtmlManifestOptions = {
  env?: NodeJS.ProcessEnv;
  enforceEval?: boolean;
};

const LOOPBACK_HTTP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/;

export function isLoopbackLibraryOrigin(origin: string): boolean {
  const match = LOOPBACK_HTTP_ORIGIN.exec(origin);
  if (!match) return false;
  return Number(match[1]) <= 65535;
}

const HTML_KEYS = new Set(["format", "csp", "libraries", "bindings", "refresh"]);
const CSP_LISTS: HtmlCspListName[] = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"];
const CSP_KEYS = new Set<string>(CSP_LISTS);

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(issues: ArtifactIssue[]): never {
  const message = issues[0]?.message ?? "Live HTML manifest is not valid";
  throw new ArtifactPublishError(400, "artifact.invalid_shape", message, issues);
}

function isDnsLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  for (let index = 0; index < label.length; index += 1) {
    const code = label.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    if (!digit && !lower && code !== 45) return false;
  }
  return true;
}

function isDnsName(host: string): boolean {
  if (host.length === 0 || host.length > HTML_CSP_HOST_MAX) return false;
  const labels = host.split(".");
  return labels.every(isDnsLabel);
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isPrivateName(host: string): boolean {
  if (host === "localhost") return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function normalizeCspOrigin(input: string): { origin: string } | { message: string } {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    return { message: "must be an https origin or a single-level wildcard (https://*.example.com)" };
  }
  const lower = input.toLowerCase();
  if (!lower.startsWith("https://")) {
    return { message: "must be an https origin or a single-level wildcard (https://*.example.com)" };
  }
  const rest = lower.slice("https://".length);
  if (rest.length === 0 || /[/?#@\\[\]\s]/.test(rest) || (rest.match(/:/g) ?? []).length > 1) {
    return { message: "must not include a path, query, userinfo, or IP address" };
  }
  let host = rest;
  let port: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
      return { message: "port is not valid" };
    }
    if (port === "443") port = undefined;
  }
  if (host.length > HTML_CSP_HOST_MAX) {
    return { message: `hostname is longer than ${HTML_CSP_HOST_MAX} characters` };
  }
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
    if (host.includes("*") || !host.includes(".")) {
      return { message: "wildcard must be a single-level subdomain (https://*.example.com)" };
    }
  } else if (host.includes("*")) {
    return { message: "wildcard must be a single-level subdomain (https://*.example.com)" };
  }
  if (isIpv4(host)) return { message: "IP addresses are not allowed" };
  if (isPrivateName(host)) {
    return { message: "localhost, .local, .internal, and .localhost names are not allowed" };
  }
  if (!isDnsName(host) || !host.includes(".")) {
    return { message: "must be an https origin with a domain name" };
  }
  const originHost = wildcard ? `*.${host}` : host;
  return { origin: port ? `https://${originHost}:${port}` : `https://${originHost}` };
}

function readCspList(value: unknown, name: HtmlCspListName, issues: ArtifactIssue[]): string[] | undefined {
  const path = `manifest.csp.${name}`;
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${name} must be an array` });
    return undefined;
  }
  if (value.length > HTML_CSP_LIST_MAX) {
    issues.push({ path, message: `at most ${HTML_CSP_LIST_MAX} entries` });
    return undefined;
  }
  const origins: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string") {
      issues.push({ path: entryPath, message: "must be a string" });
      continue;
    }
    const normalized = normalizeCspOrigin(entry);
    if ("message" in normalized) {
      issues.push({ path: entryPath, message: normalized.message });
      continue;
    }
    if (seen.has(normalized.origin)) {
      issues.push({ path: entryPath, message: "duplicate origin" });
      continue;
    }
    seen.add(normalized.origin);
    origins.push(normalized.origin);
  }
  return origins;
}

function readLibraries(value: unknown, issues: ArtifactIssue[], env: NodeJS.ProcessEnv, enforceEval: boolean): HtmlLibraryRef[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path: "manifest.libraries", message: "libraries must be an array" });
    return undefined;
  }
  if (value.length > HTML_LIBRARY_MAX) {
    issues.push({ path: "manifest.libraries", message: `at most ${HTML_LIBRARY_MAX} libraries` });
  }
  const libraries: HtmlLibraryRef[] = [];
  const seen = new Set<string>();
  const available = htmlLibraryCatalogIds();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const path = `manifest.libraries[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, message: "must be an object with name and version" });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "version" && key !== "allowEval") {
        issues.push({ path: `${path}.${key}`, message: `${key} is not a library field` });
      }
    }
    if (typeof entry.name !== "string" || typeof entry.version !== "string") {
      issues.push({ path, message: "name and version must be strings" });
      continue;
    }
    if (seen.has(entry.name)) {
      issues.push({ path, message: `duplicate library ${entry.name}` });
      continue;
    }
    seen.add(entry.name);
    const library = findHtmlLibrary(entry.name, entry.version);
    if (!library) {
      issues.push({ path, message: `unknown library ${entry.name}@${entry.version}; available: ${available}` });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(entry, "allowEval") && typeof entry.allowEval !== "boolean") {
      issues.push({ path: `${path}.allowEval`, message: "allowEval must be a boolean" });
      continue;
    }
    const allowEval = entry.allowEval === true;
    if (allowEval && !library.needsEval) {
      issues.push({ path: `${path}.allowEval`, message: "allowEval is only valid for a library that needs runtime code evaluation" });
      continue;
    }
    if (library.needsEval && enforceEval) {
      if (!allowEval) {
        issues.push({
          path,
          message: `${htmlLibraryId(library)} needs allowEval: true because it needs runtime code evaluation`,
        });
        continue;
      }
      if (!artifactEvalLibsAllowed(env)) {
        issues.push({
          path,
          message: `${htmlLibraryId(library)} needs runtime code evaluation; set STAGEFLOW_ARTIFACT_ALLOW_EVAL_LIBS=1 to allow it`,
        });
        continue;
      }
    }
    libraries.push(allowEval ? { name: library.name, version: library.version, allowEval: true } : { name: library.name, version: library.version });
  }
  return libraries;
}

export function validateHtmlManifest(raw: unknown, options: ValidateHtmlManifestOptions = {}): HtmlManifest {
  const issues: ArtifactIssue[] = [];
  if (!isRecord(raw)) fail([{ path: "manifest", message: "manifest must be an object" }]);
  for (const key of Object.keys(raw)) {
    if (!HTML_KEYS.has(key)) issues.push({ path: `manifest.${key}`, message: `${key} is not a live HTML manifest field` });
  }
  if (raw.format !== "html") {
    issues.push({ path: "manifest.format", message: "format must be html" });
  }
  if (Object.prototype.hasOwnProperty.call(raw, "library")) {
    issues.push({ path: "manifest.library", message: "library is not valid for live.html" });
  }
  const env = options.env ?? process.env;
  const enforceEval = options.enforceEval !== false;
  let libraries: HtmlLibraryRef[] | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "libraries")) {
    libraries = readLibraries(raw.libraries, issues, env, enforceEval);
  }
  const csp: HtmlCsp = {};
  if (raw.csp === undefined) {
    // default none
  } else if (!isRecord(raw.csp)) {
    issues.push({ path: "manifest.csp", message: "csp must be an object" });
  } else {
    for (const key of Object.keys(raw.csp)) {
      if (!CSP_KEYS.has(key)) issues.push({ path: `manifest.csp.${key}`, message: `${key} is not a csp field` });
    }
    for (const name of CSP_LISTS) {
      if (raw.csp[name] === undefined) continue;
      if (name === "frameDomains") {
        if (!Array.isArray(raw.csp[name])) {
          issues.push({ path: "manifest.csp.frameDomains", message: "frameDomains must be an array" });
          continue;
        }
        if (raw.csp[name].length > 0) {
          issues.push({
            path: "manifest.csp.frameDomains",
            message: "frameDomains is not supported: sandboxed artifacts cannot embed frames",
          });
        }
        continue;
      }
      const list = readCspList(raw.csp[name], name, issues);
      if (list && list.length > 0) csp[name] = list;
    }
  }
  const bindings = raw.bindings === undefined ? [] : collectLiveBindings(raw.bindings, issues);
  const refresh = collectLiveRefresh(raw.refresh, issues);
  if (issues.length > 0) fail(issues);
  const manifest: HtmlManifest = { format: "html", csp, bindings };
  if (libraries && libraries.length > 0) manifest.libraries = libraries;
  if (refresh) manifest.refresh = refresh;
  return manifest;
}

export function htmlDbManifest(manifest: HtmlManifest): Record<string, unknown> {
  return { kind: LIVE_HTML_KIND, ...manifest };
}

export function htmlIdentityHash(document: Buffer, manifest: HtmlManifest): string {
  return createHash("sha256").update(document).update("\n").update(canonicalJson(manifest)).digest("hex");
}

export function parseStoredHtmlManifest(manifestJson: string | null | undefined): HtmlManifest | undefined {
  if (!manifestJson) return undefined;
  try {
    const parsed = JSON.parse(manifestJson) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.kind !== undefined && parsed.kind !== LIVE_HTML_KIND) return undefined;
    const rest = { ...parsed };
    delete rest.kind;
    return validateHtmlManifest(rest, { enforceEval: false });
  } catch (error) {
    if (error instanceof ArtifactPublishError) return undefined;
    return undefined;
  }
}

export function loadStoredLiveBindings(manifestJson: string | null | undefined): LiveBindingSet | undefined {
  const declarative = parseStoredLiveManifest(manifestJson);
  if (declarative) {
    return { bindings: declarative.bindings, ...(declarative.refresh ? { refresh: declarative.refresh } : {}) };
  }
  const html = parseStoredHtmlManifest(manifestJson);
  if (!html) return undefined;
  return { bindings: html.bindings, ...(html.refresh ? { refresh: html.refresh } : {}) };
}

function splitOrigin(origin: string): { host: string; port?: string } | undefined {
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return undefined;
  const schemeEnd = origin.indexOf("://");
  const rest = origin.slice(schemeEnd + 3);
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return { host: rest };
  return { host: rest.slice(0, colon), port: rest.slice(colon + 1) };
}

export function cspOriginCovers(declared: readonly string[] | undefined, origin: string): boolean {
  if (!declared || declared.length === 0) return false;
  if (declared.includes(origin)) return true;
  const parsed = splitOrigin(origin);
  if (!parsed || !origin.startsWith("https://")) return false;
  for (const entry of declared) {
    if (!entry.startsWith("https://*.")) continue;
    const body = entry.slice("https://*.".length);
    const colon = body.lastIndexOf(":");
    const suffix = colon < 0 ? body : body.slice(0, colon);
    const port = colon < 0 ? undefined : body.slice(colon + 1);
    if (port !== parsed.port) continue;
    if (!parsed.host.endsWith(`.${suffix}`)) continue;
    const label = parsed.host.slice(0, parsed.host.length - suffix.length - 1);
    if (label.length > 0 && !label.includes(".")) return true;
  }
  return false;
}

function policyList(values: readonly string[] | undefined, empty: string): string {
  const items = [...new Set(values ?? [])].sort();
  if (items.length === 0) return empty;
  return items.join(" ");
}

function withPrefix(prefix: string, rest: string): string {
  return rest.length > 0 ? `${prefix} ${rest}` : prefix;
}

export type HtmlCspBuildOptions = {
  libraryDirs?: string[];
  assetDirs?: string[];
  needsEval?: boolean;
};

export type LibraryDirectorySource = {
  name: string;
  version: string;
  assets: boolean;
};

/** A vendored library directory on a loopback sandbox, or on `ownOrigin` (the shell's own origin, which may be a public https sandbox). */
export function parseLibraryDirectorySource(token: string, ownOrigin?: string): LibraryDirectorySource | null {
  if (token.includes("?") || token.includes("#") || token.includes("\\") || !token.endsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password) return null;
  const origin = `${url.protocol}//${url.host}`;
  if (!isLoopbackLibraryOrigin(origin) && origin !== ownOrigin) return null;
  if (!url.pathname.startsWith("/libs/") || !url.pathname.endsWith("/")) return null;
  const id = url.pathname.slice("/libs/".length, -1);
  if (!id || id.includes("/")) return null;
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const library = findHtmlLibrary(id.slice(0, at), id.slice(at + 1));
  if (!library) return null;
  if (token !== `${origin}/libs/${library.name}@${library.version}/`) return null;
  return { name: library.name, version: library.version, assets: library.assets };
}

export function libraryCspSources(
  shellOrigin: string,
  libraries: readonly { name: string; version: string }[],
): { libraryDirs: string[]; assetDirs: string[] } {
  if (!isLoopbackLibraryOrigin(shellOrigin)) return { libraryDirs: [], assetDirs: [] };
  const libraryDirs: string[] = [];
  const assetDirs: string[] = [];
  for (const ref of libraries) {
    const library = findHtmlLibrary(ref.name, ref.version);
    if (!library) continue;
    const dir = `${shellOrigin}/libs/${library.name}@${library.version}/`;
    if (!libraryDirs.includes(dir)) libraryDirs.push(dir);
    if (library.assets && !assetDirs.includes(dir)) assetDirs.push(dir);
  }
  libraryDirs.sort();
  assetDirs.sort();
  return { libraryDirs, assetDirs };
}

function acceptedDirs(values: readonly string[] | undefined, assetsOnly: boolean): string[] {
  const dirs: string[] = [];
  for (const token of values ?? []) {
    const parsed = parseLibraryDirectorySource(token);
    if (!parsed) continue;
    if (assetsOnly && !parsed.assets) continue;
    if (!dirs.includes(token)) dirs.push(token);
  }
  dirs.sort();
  return dirs;
}

function policyParts(head: string, dirs: readonly string[], resources: string): string {
  return [head, ...dirs, resources].filter((part) => part.length > 0).join(" ");
}

export function buildHtmlCsp(csp: HtmlCsp, options: HtmlCspBuildOptions = {}): string {
  const resource = policyList(csp.resourceDomains, "");
  const libraryDirs = acceptedDirs(options.libraryDirs, false);
  const assetDirs = acceptedDirs(options.assetDirs, true);
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
