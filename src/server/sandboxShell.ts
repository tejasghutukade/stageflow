import { createHash } from "node:crypto";
import { HTML_CSP_LIST_MAX } from "../artifacts/limits.js";
import { buildHtmlCsp, isLoopbackLibraryOrigin, parseLibraryDirectorySource, normalizeCspOrigin, type HtmlCsp, type HtmlCspBuildOptions, type LibraryDirectorySource } from "../artifacts/htmlManifest.js";
import { findHtmlLibrary, shellLibraryTable, type HtmlLibraryRef } from "../artifacts/library/htmlLibraries.js";
import {
  HOST_CONTEXT_VARIABLES,
  MAX_FRAME_HEIGHT_PX,
  MAX_FRAME_WIDTH_PX,
  MAX_INFLIGHT_REQUESTS,
  MAX_LINK_HREF_CHARS,
  MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeRuntimeSource,
} from "../artifacts/bridge/protocol.js";
import { frameAncestorOrigins } from "./sandboxPolicy.js";

export const MAX_LIVE_HTML_BYTES = 512 * 1024;
export const MAX_CSP_CHARS = 8192;
export const SHELL_MESSAGE_RATE = 200;
export const SHELL_PROTOCOL_VERSION = 1;

export function artifactDocumentCsp(csp: HtmlCsp, options?: HtmlCspBuildOptions): string {
  return buildHtmlCsp(csp, options);
}

export type LoadGuardDecision = "keep" | "teardown";

export function createLoadGuard(): { onLoad(): LoadGuardDecision } {
  let seen = 0;
  return {
    onLoad() {
      seen += 1;
      return seen === 1 ? "keep" : "teardown";
    },
  };
}

const ARTIFACT_CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "media-src",
  "connect-src",
  "frame-src",
  "base-uri",
  "form-action",
  "object-src",
] as const;

export function acceptArtifactCsp(csp: string, ownOrigin?: string, allowEval = false): boolean {
  if (typeof csp !== "string" || csp.length === 0 || csp.length > MAX_CSP_CHARS) return false;
  for (let index = 0; index < csp.length; index += 1) {
    const code = csp.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  const parts = csp.split("; ");
  if (parts.length !== ARTIFACT_CSP_DIRECTIVES.length || parts.join("; ") !== csp) return false;
  const sources: string[][] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const tokens = parts[index]!.split(" ");
    if (tokens.length < 2 || tokens.some((token) => token.length === 0)) return false;
    if (tokens[0] !== ARTIFACT_CSP_DIRECTIVES[index]) return false;
    sources.push(tokens.slice(1));
  }
  const script = sources[1];
  const style = sources[2];
  const img = sources[3];
  const font = sources[4];
  const media = sources[5];
  const connect = sources[6];
  const frame = sources[7];
  const base = sources[8];
  if (!script || !style || !img || !font || !media || !connect || !frame || !base) return false;
  if (!sameTokens(sources[0], ["'none'"])) return false;
  if (!sameTokens(sources[9], ["'none'"])) return false;
  if (!sameTokens(sources[10], ["'none'"])) return false;
  const scriptPolicy = splitLibrarySources(script, "'unsafe-inline'", ownOrigin, allowEval, true);
  const stylePolicy = splitLibrarySources(style, "'unsafe-inline'", ownOrigin, false, false);
  const imgPolicy = splitLibrarySources(img, "data:", ownOrigin, false, false);
  const fontPolicy = splitLibrarySources(font, "data:", ownOrigin, false, false);
  const mediaPolicy = splitLibrarySources(media, "data:", ownOrigin, false, false);
  if (!scriptPolicy || !stylePolicy || !imgPolicy || !fontPolicy || !mediaPolicy) return false;
  if (!sameTokens(scriptPolicy.https, stylePolicy.https)) return false;
  if (!sameTokens(scriptPolicy.https, imgPolicy.https)) return false;
  if (!sameTokens(scriptPolicy.https, fontPolicy.https)) return false;
  if (!sameTokens(scriptPolicy.https, mediaPolicy.https)) return false;
  if (!sameLibraries(scriptPolicy.dirs, stylePolicy.dirs)) return false;
  if (!sameLibraries(imgPolicy.dirs, fontPolicy.dirs)) return false;
  if (!sameLibraries(imgPolicy.dirs, scriptPolicy.dirs.filter((dir) => dir.assets))) return false;
  if (mediaPolicy.dirs.length > 0 || mediaPolicy.eval) return false;
  if (stylePolicy.eval || imgPolicy.eval || fontPolicy.eval) return false;
  if (!noneOrOrigins(connect)) return false;
  if (!sameTokens(frame, ["'none'"])) return false;
  if (!noneOrOrigins(base)) return false;
  return true;
}

function splitLibrarySources(
  tokens: readonly string[],
  head: string,
  ownOrigin: string | undefined,
  allowEval: boolean,
  permitEval: boolean,
): { https: string[]; dirs: LibraryDirectorySource[]; eval: boolean } | null {
  if (tokens[0] !== head) return null;
  let index = 1;
  let sawEval = false;
  if (tokens[index] === "'unsafe-eval'") {
    if (!permitEval || !allowEval) return null;
    sawEval = true;
    index += 1;
  }
  const dirs: LibraryDirectorySource[] = [];
  let previous = "";
  while (index < tokens.length) {
    const candidate = tokens[index];
    if (candidate === undefined) break;
    const ownDir = ownOrigin !== undefined && candidate.startsWith(`${ownOrigin}/libs/`);
    if (!ownDir && !candidate.startsWith("http://")) break;
    const parsed = parseLibraryDirectorySource(candidate, ownOrigin);
    if (!parsed || ownOrigin === undefined || !candidate.startsWith(`${ownOrigin}/libs/`)) return null;
    if (candidate <= previous) return null;
    previous = candidate;
    dirs.push(parsed);
    index += 1;
  }
  if (sawEval && dirs.length === 0) return null;
  const https = tokens.slice(index);
  if (!sortedOrigins(https, true)) return null;
  return { https, dirs, eval: sawEval };
}

function sameLibraries(left: readonly LibraryDirectorySource[], right: readonly LibraryDirectorySource[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.name === right[index]?.name && item.version === right[index]?.version);
}

function sameTokens(tokens: readonly string[] | undefined, expected: readonly string[]): boolean {
  if (!tokens || tokens.length !== expected.length) return false;
  return tokens.every((token, index) => token === expected[index]);
}

function canonicalHttpsOrigin(token: string): boolean {
  const normalized = normalizeCspOrigin(token);
  return !("message" in normalized) && normalized.origin === token;
}

function noneOrOrigins(tokens: readonly string[]): boolean {
  if (tokens.length === 1 && tokens[0] === "'none'") return true;
  return sortedOrigins(tokens, false);
}

function sortedOrigins(tokens: readonly string[], allowEmpty: boolean): boolean {
  if (tokens.length === 0) return allowEmpty;
  if (tokens.length > HTML_CSP_LIST_MAX) return false;
  let previous = "";
  for (const token of tokens) {
    if (!canonicalHttpsOrigin(token)) return false;
    if (token <= previous) return false;
    previous = token;
  }
  return true;
}

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

type Attr = { name: string; value: string | null };
type Tag = { end: number; name: string; closing: boolean; attrs: Attr[] };
type Scan = { type: "advance" } | { type: "opaque"; end: number } | { type: "tag"; tag: Tag };

export const BRIDGE_CLIENT_SOURCE = `(function () {
  var VARS = ${JSON.stringify(HOST_CONTEXT_VARIABLES)};
  var MAX_W = ${MAX_FRAME_WIDTH_PX};
  var MAX_H = ${MAX_FRAME_HEIGHT_PX};
  var MAX_HREF = ${MAX_LINK_HREF_CHARS};
  var MAX_BYTES = ${MAX_MESSAGE_BYTES};
  var MAX_PENDING = ${MAX_INFLIGHT_REQUESTS};
  var ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  var PROTOCOL = ${JSON.stringify(BRIDGE_PROTOCOL_VERSION)};
  var nextId = 1;
  var pending = Object.create(null);
  var contextListeners = [];
  var themeListeners = [];
  var bindingListeners = [];
  var sizeTimer = 0;
  function pendingCount() {
    var n = 0;
    var keys = Object.keys(pending);
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(pending, keys[i])) n += 1;
    }
    return n;
  }
  function plain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  function validateArgValue(value, depth) {
    if (depth > 32) return "arguments are too deeply nested";
    if (value === null) return null;
    var kind = typeof value;
    if (kind === "string") {
      return value.length <= MAX_BYTES ? null : "argument string is too large";
    }
    if (kind === "boolean") return null;
    if (kind === "number") return Number.isFinite(value) ? null : "argument number is not finite";
    if (kind === "function" || kind === "symbol" || kind === "bigint" || kind === "undefined") {
      return "arguments are invalid";
    }
    if (Array.isArray(value)) {
      if (value.length > 1000) return "argument array is too large";
      for (var i = 0; i < value.length; i++) {
        var item = validateArgValue(value[i], depth + 1);
        if (item) return item;
      }
      return null;
    }
    if (!plain(value)) return "arguments are invalid";
    return validateCallArgs(value, depth, 1000);
  }
  function validateCallArgs(value, depth, maxKeys) {
    if (!plain(value) || depth > 8) return "arguments are invalid";
    var keys = Object.keys(value);
    if (keys.length > maxKeys) return "too many argument keys";
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!ARG_KEY.test(key)) return 'invalid argument key "' + key + '"';
      if (value[key] === undefined) return 'invalid argument value for "' + key + '"';
      var nested = validateArgValue(value[key], depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  try {
    if (window.navigation && window.navigation.addEventListener) {
      window.navigation.addEventListener("navigate", function (event) {
        if (event.hashChange) return;
        if (event.cancelable) event.preventDefault();
      });
    }
  } catch (ignore) {}
  try {
    var hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, "href");
    if (hrefDesc && hrefDesc.get && hrefDesc.set) {
      Object.defineProperty(Location.prototype, "href", {
        configurable: true,
        enumerable: hrefDesc.enumerable,
        get: hrefDesc.get,
        set: function () {}
      });
    }
    Location.prototype.assign = function () {};
    Location.prototype.replace = function () {};
  } catch (ignore) {}
  function allowedVar(name) {
    for (var i = 0; i < VARS.length; i++) if (VARS[i] === name) return true;
    return false;
  }
  function applyContext(ctx) {
    if (!ctx || typeof ctx !== "object") return;
    var styles = ctx.styles;
    if (styles && styles.variables && typeof styles.variables === "object") {
      var names = Object.keys(styles.variables);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var value = styles.variables[name];
        if (allowedVar(name) && typeof value === "string") {
          document.documentElement.style.setProperty(name, value);
        }
      }
    }
    for (var c = 0; c < contextListeners.length; c++) contextListeners[c](ctx);
    if (ctx.theme === "dark" || ctx.theme === "light") {
      for (var t = 0; t < themeListeners.length; t++) themeListeners[t](ctx.theme);
    }
  }
  function post(message) {
    window.parent.postMessage(message, "*");
  }
  function rpc(method, params) {
    if (pendingCount() >= MAX_PENDING) {
      return Promise.reject(Object.assign(new Error("stageflow: too many pending requests"), { code: "invalid_arguments" }));
    }
    var id = nextId++;
    var timeoutMs = method === "ping" ? 10000 : 30000;
    return new Promise(function (resolve, reject) {
      var settled = false;
      function settle(kind, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete pending[id];
        kind(value);
      }
      var timer = setTimeout(function () {
        settle(reject, Object.assign(new Error("stageflow: request timed out"), { code: "timeout" }));
      }, timeoutMs);
      pending[id] = function (message) {
        if (message.error) {
          var err = new Error(message.error.message || "request failed");
          if (typeof message.error.code === "number") err.bridgeCode = message.error.code;
          settle(reject, err);
          return;
        }
        settle(resolve, message.result);
      };
      var body = { jsonrpc: "2.0", id: id, method: method };
      if (params !== undefined) body.params = params;
      post(body);
    });
  }
  function sendSize() {
    var root = document.documentElement;
    var height = root ? root.scrollHeight : 0;
    var width = root ? root.scrollWidth : 0;
    if (!(height >= 0) || !Number.isFinite(height)) height = 0;
    if (!(width >= 0) || !Number.isFinite(width)) width = 0;
    if (height > MAX_H) height = MAX_H;
    if (width > MAX_W) width = MAX_W;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: Math.round(width), height: Math.round(height) } });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/host-context-changed") {
      applyContext(message.params);
      return;
    }
    if (message.method === "ui/notifications/binding-updated") {
      var bindingId = message.params && message.params.binding_id;
      if (typeof bindingId === "string") {
        for (var b = 0; b < bindingListeners.length; b++) bindingListeners[b](bindingId);
      }
      return;
    }
    if (message.id != null && pending[message.id]) pending[message.id](message);
  });
  function hashId(href) {
    if (typeof href !== "string" || href.charAt(0) !== "#") return null;
    var raw = href.slice(1);
    if (raw === "" || raw.toLowerCase() === "top") return "";
    try { return decodeURIComponent(raw); } catch (error) { return raw; }
  }
  function scrollHash(href) {
    var id = hashId(href);
    if (id === null) return false;
    if (id === "") {
      try { window.scrollTo(0, 0); } catch (error) {}
      return true;
    }
    var node = document.getElementById(id);
    if (!node && document.getElementsByName) {
      var named = document.getElementsByName(id);
      node = named && named[0];
    }
    if (node && node.scrollIntoView) {
      try { node.scrollIntoView(); } catch (error) {}
    }
    return true;
  }
  document.addEventListener("click", function (event) {
    var node = event.target;
    if (node && node.nodeType === 3) node = node.parentNode;
    while (node && node !== document) {
      var tag = node.tagName;
      if (tag === "A" || tag === "AREA") {
        var href = node.getAttribute("href");
        if (href === null) href = "";
        event.preventDefault();
        if (!scrollHash(href)) {
          post({ jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: String(href).slice(0, MAX_HREF) } });
        }
        return;
      }
      node = node.parentNode;
    }
  }, true);
  if (typeof ResizeObserver === "function") {
    var observer = new ResizeObserver(function () {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(sendSize, 100);
    });
    observer.observe(document.documentElement);
  }
  window.stageflow = {
    initialize: function () {
      return rpc("ui/initialize", {
        protocolVersion: PROTOCOL,
        appInfo: { name: "live-html", version: "1" },
        appCapabilities: { availableDisplayModes: ["inline"] }
      }).then(function (result) {
        var ctx = result && result.hostContext;
        applyContext(ctx);
        sendSize();
        return ctx;
      });
    },
    callBinding: function (bindingId, args) {
      if (args !== undefined) {
        var problem = validateCallArgs(args, 0, 16);
        if (problem) {
          return Promise.reject(Object.assign(new Error("stageflow: " + problem), { code: "invalid_arguments" }));
        }
      }
      var params = { name: bindingId };
      if (args !== undefined) params.arguments = args;
      return rpc("tools/call", params).then(function (result) {
        if (result && result.isError) {
          var text = "binding call failed";
          if (result.content && result.content[0] && typeof result.content[0].text === "string") text = result.content[0].text;
          var error = new Error(text);
          if (result._meta && result._meta.retryable === true) error.retryable = true;
          throw error;
        }
        return result ? result.structuredContent : undefined;
      });
    },
    onHostContextChanged: function (cb) { contextListeners.push(cb); },
    onThemeChanged: function (cb) { themeListeners.push(cb); },
    onBindingUpdated: function (cb) { bindingListeners.push(cb); }
  };
})();
`;

export const SHELL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Stageflow sandbox</title>
<style>html,body{margin:0;background:transparent}iframe{width:100%;border:0;display:block;height:0}</style>
</head>
<body>
<iframe id="sf-live" title="Live artifact"></iframe>
<script src="/shell.js"></script>
</body>
</html>
`;

export type HashClickPlan = "top" | "scroll" | "missing" | "blocked";

export function resolveHashScrollTarget(href: string): { kind: "top" } | { kind: "id"; id: string } | null {
  if (!href.startsWith("#")) return null;
  const raw = href.slice(1);
  if (raw === "" || raw.toLowerCase() === "top") return { kind: "top" };
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw;
  }
  return { kind: "id", id };
}

export function planHashClick(
  href: string,
  lookup: { byId: (id: string) => boolean; byName: (name: string) => boolean },
): HashClickPlan {
  const target = resolveHashScrollTarget(href);
  if (!target) return "blocked";
  if (target.kind === "top") return "top";
  if (lookup.byId(target.id) || lookup.byName(target.id)) return "scroll";
  return "missing";
}

export function isHashNavigation(href: string): boolean {
  return href.startsWith("#") && !href.includes("\\");
}

export function truncateHref(href: string): string {
  return href.length > MAX_LINK_HREF_CHARS ? href.slice(0, MAX_LINK_HREF_CHARS) : href;
}

export function clampFrameHeight(height: number): number {
  if (!Number.isFinite(height) || height < 0) return 0;
  return Math.min(MAX_FRAME_HEIGHT_PX, Math.round(height));
}

export function clampFrameWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0) return 0;
  return Math.min(MAX_FRAME_WIDTH_PX, Math.round(width));
}

export function clampSizeChangedParams(params: unknown): Record<string, unknown> | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  if (keys.some((key) => key !== "width" && key !== "height")) return null;
  const next: Record<string, unknown> = { ...record };
  if (Object.prototype.hasOwnProperty.call(record, "width")) {
    if (typeof record.width !== "number" || !Number.isFinite(record.width)) return null;
    next.width = clampFrameWidth(record.width);
  }
  if (Object.prototype.hasOwnProperty.call(record, "height")) {
    if (typeof record.height !== "number" || !Number.isFinite(record.height)) return null;
    next.height = clampFrameHeight(record.height);
  }
  return next;
}

export function prepareSizeChangedMessage<T extends { method?: string; params?: unknown }>(message: T): T {
  if (message.method !== "ui/notifications/size-changed") return message;
  const params = clampSizeChangedParams(message.params);
  if (!params) return message;
  return { ...message, params };
}

export function allowMessageRate(bucket: number[], now: number, limit = SHELL_MESSAGE_RATE): boolean {
  const cutoff = now - 1000;
  while (bucket.length > 0 && bucket[0]! < cutoff) bucket.shift();
  if (bucket.length >= limit) return false;
  bucket.push(now);
  return true;
}

export function noteInflight(active: Set<string>, id: string, max: number): boolean {
  if (active.has(id)) return false;
  if (active.size >= max) return false;
  active.add(id);
  return true;
}

export function liveLibraryTags(libraries: readonly Pick<HtmlLibraryRef, "name" | "version">[], origin: string): string | null {
  if (!isLoopbackLibraryOrigin(origin)) return null;
  let html = "";
  for (const ref of libraries) {
    const library = findHtmlLibrary(ref.name, ref.version);
    if (!library) return null;
    for (const file of library.files) {
      if (file.kind === "asset") continue;
      const url = escapeAttr(`${origin}/libs/${library.name}@${library.version}/${file.path}`);
      const integrity = escapeAttr(file.integrity);
      if (file.kind === "style") {
        html += `<link rel="stylesheet" href="${url}" integrity="${integrity}" crossorigin="anonymous">`;
      } else {
        html += `<script src="${url}" integrity="${integrity}" crossorigin="anonymous"></script>`;
      }
    }
  }
  return html;
}

export function buildLiveDocument(
  html: string,
  csp: string,
  bridgeScript = BRIDGE_CLIENT_SOURCE,
  libraries?: readonly Pick<HtmlLibraryRef, "name" | "version">[],
  origin?: string,
): string {
  const bom = html.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const source = bom ? html.slice(1) : html;
  const body = neutralizeLiveHtml(source).replace(/^\s*<!doctype\s+html\s*>/i, "");
  const script = bridgeScript.replace(/<\/script/gi, "<\\/script");
  const tags = libraries && libraries.length > 0 && origin ? liveLibraryTags(libraries, origin) ?? "" : "";
  return `${bom}<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">${tags}<script>${script}</script></head><body>${body}</body></html>`;
}

export function shellScript(consoleOrigins: readonly string[], options?: { allowEval?: boolean }): string {
  const parents = frameAncestorOrigins(consoleOrigins);
  const allowEval = options?.allowEval === true;
  return `'use strict';
var CONSOLES = ${JSON.stringify(parents)};
var VARS = ${JSON.stringify(HOST_CONTEXT_VARIABLES)};
var LIBS = ${JSON.stringify(shellLibraryTable())};
var ALLOW_EVAL = ${allowEval ? "true" : "false"};
var MAX_RELAY = ${MAX_MESSAGE_BYTES};
var MAX_HTML = ${MAX_LIVE_HTML_BYTES};
var MAX_CSP = ${MAX_CSP_CHARS};
var MAX_RATE = ${SHELL_MESSAGE_RATE};
var MAX_FLIGHT = 100;
var MAX_H = ${MAX_FRAME_HEIGHT_PX};
var BRIDGE = ${JSON.stringify(BRIDGE_CLIENT_SOURCE)};
${bridgeRuntimeSource()}
${SHELL_LIB}
if (typeof globalThis !== "undefined") {
  globalThis.__sfBuildLiveDocument = buildLiveDocument;
  globalThis.__sfAcceptRelay = acceptRelay;
  globalThis.__sfAcceptCsp = acceptArtifactCsp;
  globalThis.__sfParseLoad = parseSandboxLoadParams;
  globalThis.__sfCreateLoadGuard = createLoadGuard;
}
if (typeof window !== "undefined") startShell();
`;
}

export function shellHtmlSha256(): string {
  return createHash("sha256").update(SHELL_HTML).digest("hex");
}

export function shellScriptSha256(consoleOrigins: readonly string[]): string {
  return createHash("sha256").update(shellScript(consoleOrigins)).digest("hex");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isWs(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z"));
}

function isNameChar(char: string): boolean {
  return isNameStart(char) || (char >= "0" && char <= "9") || char === ":" || char === "-";
}

function isAttrStart(char: string): boolean {
  return isNameStart(char) || char === "_" || char === ":";
}

function isAttrChar(char: string): boolean {
  return isAttrStart(char) || (char >= "0" && char <= "9") || char === "." || char === "-";
}

function scanToGt(input: string, from: number): number {
  const gt = input.indexOf(">", from);
  return gt === -1 ? input.length : gt + 1;
}

function scanCommentEnd(input: string, lt: number): number {
  let j = lt + 4;
  let state: "start" | "start-dash" | "comment" | "end-dash" | "end" | "bang" = "start";
  while (j < input.length) {
    const char = input[j]!;
    if (state === "start") {
      if (char === ">") return j + 1;
      state = char === "-" ? "start-dash" : "comment";
    } else if (state === "start-dash") {
      if (char === ">") return j + 1;
      state = char === "-" ? "end" : "comment";
    } else if (state === "comment") {
      if (char === "-") state = "end-dash";
    } else if (state === "end-dash") {
      state = char === "-" ? "end" : "comment";
    } else if (state === "end") {
      if (char === ">") return j + 1;
      if (char === "!") state = "bang";
      else if (char !== "-") state = "comment";
    } else if (char === ">") {
      return j + 1;
    } else {
      state = char === "-" ? "end-dash" : "comment";
    }
    j += 1;
  }
  return input.length;
}

function findTagEnd(input: string, i: number): number {
  while (i < input.length) {
    while (i < input.length && isWs(input[i]!)) i += 1;
    if (i >= input.length) return -1;
    const char = input[i]!;
    if (char === ">") return i + 1;
    if (char === "/" && input[i + 1] === ">") return i + 2;
    if (!isAttrStart(char)) {
      i += 1;
      continue;
    }
    i += 1;
    while (i < input.length && isAttrChar(input[i]!)) i += 1;
    while (i < input.length && isWs(input[i]!)) i += 1;
    if (input[i] !== "=") continue;
    i += 1;
    while (i < input.length && isWs(input[i]!)) i += 1;
    if (i >= input.length) return -1;
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i]!;
      i += 1;
      while (i < input.length && input[i] !== quote) i += 1;
      if (i >= input.length) return -1;
      i += 1;
      continue;
    }
    while (i < input.length && !isWs(input[i]!) && input[i] !== ">") i += 1;
  }
  return -1;
}

function parseTag(input: string, lt: number, closing: boolean): Tag | null {
  let i = lt + (closing ? 2 : 1);
  const nameStart = i;
  i += 1;
  while (i < input.length && isNameChar(input[i]!)) i += 1;
  const name = input.slice(nameStart, i).toLowerCase();
  const end = findTagEnd(input, i);
  if (end < 0) return null;
  const attrs: Attr[] = [];
  while (i < end) {
    while (i < end && isWs(input[i]!)) i += 1;
    if (i >= end) break;
    const char = input[i]!;
    if (char === ">" || (char === "/" && input[i + 1] === ">")) break;
    if (!isAttrStart(char)) {
      i += 1;
      continue;
    }
    const attrStart = i;
    i += 1;
    while (i < end && isAttrChar(input[i]!)) i += 1;
    const attrName = input.slice(attrStart, i).toLowerCase();
    while (i < end && isWs(input[i]!)) i += 1;
    if (input[i] !== "=") {
      attrs.push({ name: attrName, value: null });
      continue;
    }
    i += 1;
    while (i < end && isWs(input[i]!)) i += 1;
    if (i >= end) break;
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i]!;
      i += 1;
      const valueStart = i;
      while (i < end && input[i] !== quote) i += 1;
      const value = input.slice(valueStart, i);
      if (input[i] === quote) i += 1;
      attrs.push({ name: attrName, value });
      continue;
    }
    const valueStart = i;
    while (i < end && !isWs(input[i]!) && input[i] !== ">") i += 1;
    attrs.push({ name: attrName, value: input.slice(valueStart, i) });
  }
  return { end, name, closing, attrs };
}

function scanAt(input: string, lt: number): Scan {
  const next = input[lt + 1];
  if (next === undefined) return { type: "advance" };
  if (next === "!") {
    if (input.startsWith("<!--", lt)) return { type: "opaque", end: scanCommentEnd(input, lt) };
    return { type: "opaque", end: scanToGt(input, lt + 2) };
  }
  if (next === "?") return { type: "opaque", end: scanToGt(input, lt + 2) };
  if (next === "/") {
    if (!isNameStart(input[lt + 2])) return { type: "opaque", end: scanToGt(input, lt + 2) };
    const tag = parseTag(input, lt, true);
    if (!tag) return { type: "opaque", end: input.length };
    return { type: "tag", tag };
  }
  if (!isNameStart(next)) return { type: "advance" };
  const tag = parseTag(input, lt, false);
  if (!tag) return { type: "opaque", end: input.length };
  return { type: "tag", tag };
}

function rawTextEnd(input: string, name: string, openTagEnd: number): number {
  const needle = `</${name}`;
  const at = input.toLowerCase().indexOf(needle, openTagEnd);
  if (at === -1) return input.length;
  const gt = input.indexOf(">", at + needle.length);
  return gt === -1 ? input.length : gt + 1;
}

function isRefresh(tag: Tag): boolean {
  return tag.attrs.some((attr) => attr.name === "http-equiv" && (attr.value ?? "").trim().toLowerCase() === "refresh");
}

function neutralizeLiveHtml(input: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "<") {
      i += 1;
      continue;
    }
    const scanned = scanAt(input, i);
    if (scanned.type === "advance") {
      i += 1;
      continue;
    }
    if (scanned.type === "opaque") {
      i = scanned.end;
      continue;
    }
    const tag = scanned.tag;
    if (!tag.closing && RAW_TEXT.has(tag.name)) {
      i = rawTextEnd(input, tag.name, tag.end);
      continue;
    }
    if (!tag.closing && (tag.name === "base" || (tag.name === "meta" && isRefresh(tag)))) {
      if (cursor < i) parts.push(input.slice(cursor, i));
      cursor = tag.end;
    }
    i = tag.end;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts.join("");
}

const SHELL_LIB = String.raw`
function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
function allowRate(bucket, now) {
  var cutoff = now - 1000;
  while (bucket.length && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= MAX_RATE) return false;
  bucket.push(now);
  return true;
}
function idOk(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[\x20-\x7e]+$/.test(value);
}
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function buildLiveDocument(html, csp, libraries) {
  var bom = html.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  var source = bom ? html.slice(1) : html;
  var body = neutralize(source).replace(/^\s*<!doctype\s+html\s*>/i, "");
  var script = String(BRIDGE).split("</" + "script").join("<\\" + "/script");
  var escaped = String(csp).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  var tags = libraryTags(libraries);
  return bom + "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"" + escaped + "\">" + tags + "<script>" + script + "</script></head><body>" + body + "</body></html>";
}
function libraryTags(libraries) {
  if (!libraries || !libraries.length) return "";
  var origin = location.origin;
  var html = "";
  for (var i = 0; i < libraries.length; i++) {
    var ref = libraries[i];
    var lib = null;
    for (var j = 0; j < LIBS.length; j++) {
      if (LIBS[j].name === ref.name && LIBS[j].version === ref.version) lib = LIBS[j];
    }
    if (!lib) return "";
    for (var f = 0; f < lib.files.length; f++) {
      var file = lib.files[f];
      if (file.kind === "asset") continue;
      var url = origin + "/libs/" + lib.name + "@" + lib.version + "/" + file.path;
      if (file.kind === "style") html += '<link rel="stylesheet" href="' + url + '" integrity="' + file.integrity + '" crossorigin="anonymous">';
      else html += '<script src="' + url + '" integrity="' + file.integrity + '" crossorigin="anonymous"></script>';
    }
  }
  return html;
}
function lookupLibrary(ref) {
  for (var j = 0; j < LIBS.length; j++) {
    if (LIBS[j].name === ref.name && LIBS[j].version === ref.version) return LIBS[j];
  }
  return null;
}
function neutralize(input) {
  var parts = [];
  var cursor = 0;
  var i = 0;
  while (i < input.length) {
    if (input.charAt(i) !== "<") { i += 1; continue; }
    var end = tagEnd(input, i);
    if (end < 0) { i += 1; continue; }
    var slice = input.slice(i, end);
    var name = tagName(slice);
    if (name && isRaw(name) && slice.charAt(1) !== "/") {
      var raw = rawEnd(input, name, end);
      i = raw;
      continue;
    }
    if (name && slice.charAt(1) !== "/" && (name === "base" || (name === "meta" && /http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)/i.test(slice)))) {
      if (cursor < i) parts.push(input.slice(cursor, i));
      cursor = end;
    }
    i = end;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts.join("");
}
function isRaw(name) {
  return name === "script" || name === "style" || name === "textarea" || name === "title";
}
function tagName(slice) {
  var match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(slice);
  return match ? match[1].toLowerCase() : "";
}
function tagEnd(input, lt) {
  var next = input.charAt(lt + 1);
  if (next === "!" && input.slice(lt, lt + 4) === "<!--") {
    var comment = input.indexOf("-->", lt + 4);
    return comment < 0 ? input.length : comment + 3;
  }
  var quote = "";
  for (var i = lt + 1; i < input.length; i++) {
    var char = input.charAt(i);
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ">") return i + 1;
  }
  return input.length;
}
function rawEnd(input, name, from) {
  var lower = input.toLowerCase();
  var at = lower.indexOf("</" + name, from);
  if (at < 0) return input.length;
  var gt = input.indexOf(">", at);
  return gt < 0 ? input.length : gt + 1;
}
function acceptRelay(value) {
  try {
    var parsed = parseBridgeMessage(value);
    return !!(parsed && parsed.ok);
  } catch (error) {
    return false;
  }
}
function acceptFromNested(value) {
  if (!acceptRelay(value)) return false;
  return !(value && value.method === "ui/notifications/binding-updated");
}
function clampSizeMessage(data) {
  if (!data || data.method !== "ui/notifications/size-changed" || !plain(data.params)) return data;
  var params = data.params;
  var keys = Object.keys(params);
  if (!keys.length || keys.some(function (key) { return key !== "width" && key !== "height"; })) return data;
  var next = {};
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = params[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return data;
    if (value < 0) value = 0;
    if (key === "width") value = Math.min(MAX_FRAME_WIDTH_PX, Math.round(value));
    if (key === "height") value = Math.min(MAX_H, Math.round(value));
    next[key] = value;
  }
  var copy = {};
  for (var field in data) {
    if (Object.prototype.hasOwnProperty.call(data, field)) copy[field] = data[field];
  }
  copy.params = next;
  return copy;
}
function nestedRequestId(data) {
  if (!plain(data) || data.jsonrpc !== "2.0") return null;
  if (data.result !== undefined || data.error !== undefined) return null;
  if (data.method === undefined || typeof data.method !== "string") return null;
  if (data.id === undefined) return null;
  return idOk(data.id) ? data.id : null;
}
function relayErrorMessage(code) {
  if (code === BRIDGE_ERROR.INVALID_PARAMS) return "Invalid params";
  if (code === BRIDGE_ERROR.METHOD_NOT_FOUND) return "Method not found";
  if (code === BRIDGE_ERROR.PARSE) return "Invalid request";
  if (code === -32000) return "Request rejected";
  return "Invalid request";
}
function acceptArtifactCsp(csp, ownOrigin, allowEval) {
  if (typeof csp !== "string" || csp.length < 1 || csp.length > MAX_CSP) return false;
  for (var i = 0; i < csp.length; i++) {
    var code = csp.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  var parts = csp.split("; ");
  if (parts.length !== 11 || parts.join("; ") !== csp) return false;
  var names = ["default-src","script-src","style-src","img-src","font-src","media-src","connect-src","frame-src","base-uri","form-action","object-src"];
  var parsed = [];
  for (var d = 0; d < 11; d++) {
    var tokens = parts[d].split(" ");
    if (tokens.length < 2 || tokens[0] !== names[d]) return false;
    for (var t = 0; t < tokens.length; t++) if (!tokens[t]) return false;
    parsed.push(tokens.slice(1));
  }
  if (parsed[0].length !== 1 || parsed[0][0] !== "'none'") return false;
  if (parsed[7].length !== 1 || parsed[7][0] !== "'none'") return false;
  if (parsed[9].length !== 1 || parsed[9][0] !== "'none'") return false;
  if (parsed[10].length !== 1 || parsed[10][0] !== "'none'") return false;
  var script = splitLib(parsed[1], "'unsafe-inline'", ownOrigin, allowEval === true, true);
  var style = splitLib(parsed[2], "'unsafe-inline'", ownOrigin, false, false);
  var img = splitLib(parsed[3], "data:", ownOrigin, false, false);
  var font = splitLib(parsed[4], "data:", ownOrigin, false, false);
  var media = splitLib(parsed[5], "data:", ownOrigin, false, false);
  if (!script || !style || !img || !font || !media) return false;
  if (!sameTokens(script.https, style.https) || !sameTokens(script.https, img.https) || !sameTokens(script.https, font.https) || !sameTokens(script.https, media.https)) return false;
  if (!sameLibs(script.dirs, style.dirs) || !sameLibs(img.dirs, font.dirs) || !sameLibs(img.dirs, assetLibs(script.dirs))) return false;
  if (media.dirs.length || media.eval || style.eval || img.eval || font.eval) return false;
  if (!noneOrOrigins(parsed[6]) || !noneOrOrigins(parsed[8])) return false;
  return true;
}
function splitLib(tokens, head, ownOrigin, allowEval, permitEval) {
  if (tokens[0] !== head) return null;
  var index = 1;
  var sawEval = false;
  if (tokens[index] === "'unsafe-eval'") {
    if (!permitEval || !allowEval) return null;
    sawEval = true;
    index += 1;
  }
  var dirs = [];
  var prev = "";
  while (index < tokens.length) {
    var candidate = tokens[index];
    var ownDir = !!ownOrigin && candidate.indexOf(ownOrigin + "/libs/") === 0;
    if (!ownDir && candidate.indexOf("http://") !== 0) break;
    var lib = libraryDir(candidate, ownOrigin);
    if (!lib || candidate <= prev) return null;
    prev = candidate;
    dirs.push(lib);
    index += 1;
  }
  if (sawEval && !dirs.length) return null;
  var https = tokens.slice(index);
  if (!sortedOrigins(https, true)) return null;
  return { https: https, dirs: dirs, eval: sawEval };
}
function libraryDir(token, ownOrigin) {
  if (!ownOrigin || token.indexOf(ownOrigin + "/libs/") !== 0 || token.charAt(token.length - 1) !== "/") return null;
  if (token.indexOf("?") >= 0 || token.indexOf("#") >= 0 || token.indexOf("\\") >= 0) return null;
  var id = token.slice((ownOrigin + "/libs/").length, -1);
  if (!id || id.indexOf("/") >= 0) return null;
  var at = id.lastIndexOf("@");
  if (at <= 0) return null;
  var name = id.slice(0, at);
  var version = id.slice(at + 1);
  var expected = ownOrigin + "/libs/" + name + "@" + version + "/";
  if (token !== expected) return null;
  for (var i = 0; i < LIBS.length; i++) {
    if (LIBS[i].name === name && LIBS[i].version === version) return LIBS[i];
  }
  return null;
}
function sameLibs(left, right) {
  if (left.length !== right.length) return false;
  for (var i = 0; i < left.length; i++) {
    if (left[i].name !== right[i].name || left[i].version !== right[i].version) return false;
  }
  return true;
}
function assetLibs(dirs) {
  var out = [];
  for (var i = 0; i < dirs.length; i++) if (dirs[i].assets) out.push(dirs[i]);
  return out;
}
function sameTokens(tokens, expected) {
  if (tokens.length !== expected.length) return false;
  for (var i = 0; i < tokens.length; i++) if (tokens[i] !== expected[i]) return false;
  return true;
}
function headOrigins(tokens, head, allowEmpty) {
  if (tokens[0] !== head) return null;
  var origins = tokens.slice(1);
  if (!sortedOrigins(origins, allowEmpty)) return null;
  return origins;
}
function noneOrOrigins(tokens) {
  if (tokens.length === 1 && tokens[0] === "'none'") return true;
  return sortedOrigins(tokens, false);
}
function sortedOrigins(tokens, allowEmpty) {
  if (!tokens.length) return allowEmpty;
  if (tokens.length > 8) return false;
  var prev = "";
  for (var i = 0; i < tokens.length; i++) {
    if (!httpsOrigin(tokens[i]) || tokens[i] <= prev) return false;
    prev = tokens[i];
  }
  return true;
}
function httpsOrigin(token) {
  if (token.indexOf("https://") !== 0 || token !== token.toLowerCase()) return false;
  var rest = token.slice("https://".length);
  if (!rest || badOriginChar(rest)) return false;
  var colon = rest.lastIndexOf(":");
  var host = rest;
  if (colon >= 0) {
    if (rest.indexOf(":") !== colon) return false;
    host = rest.slice(0, colon);
    var port = rest.slice(colon + 1);
    if (!portOk(port)) return false;
  }
  if (!host || host.length > 253) return false;
  if (host.indexOf("*.") === 0) {
    host = host.slice(2);
    if (host.indexOf("*") >= 0 || host.indexOf(".") < 0) return false;
  } else if (host.indexOf("*") >= 0) return false;
  if (isIpv4(host)) return false;
  if (host === "localhost" || endsWith(host, ".localhost") || endsWith(host, ".local") || endsWith(host, ".internal")) return false;
  if (host.indexOf(".") < 0) return false;
  var labels = host.split(".");
  for (var n = 0; n < labels.length; n++) {
    var label = labels[n];
    if (!label || label.length > 63) return false;
    if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") return false;
    for (var c = 0; c < label.length; c++) {
      var ch = label.charAt(c);
      var ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
      if (!ok) return false;
    }
  }
  return true;
}
function badOriginChar(value) {
  for (var i = 0; i < value.length; i++) {
    var ch = value.charAt(i);
    if (ch === "/" || ch === "?" || ch === "#" || ch === "@" || ch === "[" || ch === "]" || ch === " " || ch === "\t" || ch === "\\") return true;
  }
  return false;
}
function portOk(port) {
  if (!port || port === "443" || port.charAt(0) === "0") return false;
  var value = 0;
  for (var i = 0; i < port.length; i++) {
    var ch = port.charAt(i);
    if (ch < "0" || ch > "9" || port.length > 5) return false;
    value = value * 10 + (ch.charCodeAt(0) - 48);
  }
  return value >= 1 && value <= 65535;
}
function isIpv4(host) {
  var parts = host.split(".");
  if (parts.length !== 4) return false;
  for (var i = 0; i < 4; i++) {
    var part = parts[i];
    if (!part || part.length > 3) return false;
    var value = 0;
    for (var c = 0; c < part.length; c++) {
      var ch = part.charAt(c);
      if (ch < "0" || ch > "9") return false;
      value = value * 10 + (ch.charCodeAt(0) - 48);
    }
    if (value > 255) return false;
  }
  return true;
}
function endsWith(value, suffix) {
  return value.length >= suffix.length && value.slice(value.length - suffix.length) === suffix;
}
function createLoadGuard() {
  var seen = 0;
  return {
    onLoad: function () {
      seen += 1;
      return seen === 1 ? "keep" : "teardown";
    }
  };
}
function startShell() {
  var params = new URLSearchParams(location.search);
  var parentOrigin = params.get("parent") || "";
  var allowed = false;
  for (var i = 0; i < CONSOLES.length; i++) if (CONSOLES[i] === parentOrigin) allowed = true;
  if (!allowed) return;
  var loaded = false;
  var alive = true;
  var nonce = "";
  var frame = document.getElementById("sf-live");
  var loadGuard = createLoadGuard();
  var hostTimes = [];
  var nestedTimes = [];
  var hostFlight = Object.create(null);
  var nestedFlight = Object.create(null);
  var hostFlightCount = 0;
  var nestedFlightCount = 0;
  function replyNestedError(id, code, message) {
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ jsonrpc: "2.0", id: id, error: { code: code, message: message } }, "*");
    }
  }
  window.parent.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } }, parentOrigin);
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source === window.parent) {
      if (event.origin !== parentOrigin) return;
      onHost(data);
      return;
    }
    if (alive && frame && event.source === frame.contentWindow) onNested(data);
  });
  function onNestedLoad() {
    if (!alive) return;
    if (loadGuard.onLoad() === "keep") return;
    alive = false;
    var node = frame.parentNode;
    if (node && node.removeChild) node.removeChild(frame);
    window.parent.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "navigated" } }, parentOrigin);
  }
  function onHost(data) {
    if (!alive) return;
    if (!plain(data) || data.jsonrpc !== "2.0") return;
    var size;
    try { size = byteLength(data); } catch (error) { return; }
    if (data.method === "sf/sandbox-load") {
      if (size > MAX_HTML + MAX_CSP + 1024) return;
      if (loaded) return;
      var parsedLoad = parseSandboxLoadParams(data.params);
      if (!parsedLoad.ok) return;
      var load = parsedLoad.load;
      var evalAllowed = ALLOW_EVAL && load.allowEval === true;
      if (!acceptArtifactCsp(load.csp, location.origin, evalAllowed)) {
        window.parent.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "csp" } }, parentOrigin);
        return;
      }
      var selected = [];
      for (var n = 0; n < load.libraries.length; n++) {
        var found = lookupLibrary(load.libraries[n]);
        if (!found || (found.needsEval && !evalAllowed)) {
          window.parent.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "library" } }, parentOrigin);
          return;
        }
        selected.push(load.libraries[n]);
      }
      if (new TextEncoder().encode(load.html).length > MAX_HTML) return;
      loaded = true;
      nonce = load.nonce;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("allow", "");
      frame.addEventListener("load", onNestedLoad);
      frame.setAttribute("srcdoc", buildLiveDocument(load.html, load.csp, selected));
      return;
    }
    if (data.method !== "sf/sandbox-relay" || !loaded) return;
    if (size > MAX_RELAY + 256) return;
    var relay = data.params;
    if (!plain(relay) || relay.nonce !== nonce || !acceptRelay(relay.message)) return;
    if (!allowRate(hostTimes, Date.now())) return;
    var message = relay.message;
    if (message.method && message.id !== undefined && message.result === undefined && message.error === undefined) {
      var key = String(message.id);
      if (hostFlight[key] || hostFlightCount >= MAX_FLIGHT) return;
      hostFlight[key] = 1;
      hostFlightCount += 1;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      var reply = String(message.id);
      if (nestedFlight[reply]) {
        delete nestedFlight[reply];
        nestedFlightCount -= 1;
      }
    }
    if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
  }
  function onNested(data) {
    if (!alive || !loaded) return;
    if (data && data.method === "ui/notifications/binding-updated") return;
    data = clampSizeMessage(data);
    var requestId = nestedRequestId(data);
    var size;
    try { size = byteLength(data); } catch (error) {
      if (requestId != null) replyNestedError(requestId, BRIDGE_ERROR.INVALID_REQUEST, "Invalid request");
      return;
    }
    if (size > MAX_RELAY) {
      if (requestId != null) replyNestedError(requestId, BRIDGE_ERROR.INVALID_REQUEST, "Invalid request");
      return;
    }
    if (!allowRate(nestedTimes, Date.now())) {
      if (requestId != null) replyNestedError(requestId, -32000, "Request rejected");
      return;
    }
    var parsed;
    try { parsed = parseBridgeMessage(data); } catch (error) {
      if (requestId != null) replyNestedError(requestId, BRIDGE_ERROR.INVALID_REQUEST, "Invalid request");
      return;
    }
    if (!parsed.ok) {
      if (requestId != null) {
        var failCode = parsed.error.code;
        if (failCode !== BRIDGE_ERROR.INVALID_PARAMS && failCode !== BRIDGE_ERROR.METHOD_NOT_FOUND && failCode !== BRIDGE_ERROR.PARSE) {
          failCode = BRIDGE_ERROR.INVALID_REQUEST;
        }
        replyNestedError(requestId, failCode, relayErrorMessage(failCode));
      }
      return;
    }
    data = parsed.message;
    if (data.method === "ui/notifications/binding-updated") return;
    if (data.method && data.id !== undefined && data.result === undefined && data.error === undefined) {
      var key = String(data.id);
      if (nestedFlight[key]) {
        if (requestId != null) replyNestedError(requestId, -32000, "Request rejected");
        return;
      }
      if (nestedFlightCount >= MAX_FLIGHT) {
        if (requestId != null) replyNestedError(requestId, -32000, "Request rejected");
        return;
      }
      nestedFlight[key] = 1;
      nestedFlightCount += 1;
    }
    if (data.id !== undefined && (data.result !== undefined || data.error !== undefined)) {
      var reply = String(data.id);
      if (hostFlight[reply]) {
        delete hostFlight[reply];
        hostFlightCount -= 1;
      }
    }
    if (data.method === "ui/notifications/size-changed" && plain(data.params) && typeof data.params.height === "number") {
      var height = data.params.height;
      if (!(height >= 0)) height = 0;
      if (height > MAX_H) height = MAX_H;
      frame.style.height = Math.round(height) + "px";
    }
    window.parent.postMessage({ jsonrpc: "2.0", method: "sf/sandbox-relay", params: { nonce: nonce, message: data } }, parentOrigin);
  }
}
`;
