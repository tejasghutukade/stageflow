import { withArtifactValidation } from "./program.js";
import {
  cspOriginCovers,
  type HtmlCsp,
  type HtmlCspListName,
} from "./htmlManifest.js";
import {
  HTML_SCAN_BUDGET_MS,
  HTML_SCAN_MAX_ATTR_BYTES,
  HTML_SCAN_MAX_ELEMENTS,
  HTML_SCAN_MAX_LINE_BYTES,
  LIVE_HTML_MAX_BYTES,
  ArtifactPublishError,
  type ArtifactIssue,
} from "./limits.js";

export type HtmlScanOrigins = {
  script: string[];
  style: string[];
  img: string[];
  media: string[];
  font: string[];
  frame: string[];
  base: string[];
  connect: string[];
};

export type HtmlScanResult = {
  ok: boolean;
  issues: ArtifactIssue[];
  warnings: ArtifactIssue[];
  origins: HtmlScanOrigins;
};

export type HtmlScanOptions = {
  csp?: HtmlCsp;
  now?: () => number;
  budgetMs?: number;
};

const ISSUE_CAP = 64;
const KEPT_ATTRS = new Set([
  "src",
  "srcset",
  "href",
  "data",
  "action",
  "formaction",
  "http-equiv",
  "content",
  "style",
  "rel",
  "as",
  "xlink:href",
  "poster",
  "background",
  "imagesrcset",
  "integrity",
  "crossorigin",
  "type",
]);
const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);
const NETWORK_NEEDLES = ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource"];

type Bucket = keyof HtmlScanOrigins;

type State = {
  input: string;
  i: number;
  lineBytes: number;
  elements: number;
  issues: ArtifactIssue[];
  warnings: ArtifactIssue[];
  origins: HtmlScanOrigins;
  counts: Map<string, number>;
  stopped: boolean;
  started: number;
  now: () => number;
  budgetMs: number;
  steps: number;
  csp: HtmlCsp;
  networkWarned: boolean;
};

function emptyOrigins(): HtmlScanOrigins {
  return { script: [], style: [], img: [], media: [], font: [], frame: [], base: [], connect: [] };
}

function utf8Len(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) return 4;
  return 3;
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

function limitIssue(code: string, message: string): ArtifactIssue {
  return { path: "content", code, message };
}

export function scanHtml(input: string, options: HtmlScanOptions = {}): HtmlScanResult {
  const origins = emptyOrigins();
  if (Buffer.byteLength(input, "utf8") > LIVE_HTML_MAX_BYTES) {
    return {
      ok: false,
      issues: [limitIssue("html_document_too_large", `document is larger than ${LIVE_HTML_MAX_BYTES} bytes`)],
      warnings: [],
      origins,
    };
  }
  const now = options.now ?? Date.now;
  const state: State = {
    input,
    i: 0,
    lineBytes: 0,
    elements: 0,
    issues: [],
    warnings: [],
    origins,
    counts: new Map(),
    stopped: false,
    started: now(),
    now,
    budgetMs: options.budgetMs ?? HTML_SCAN_BUDGET_MS,
    steps: 0,
    csp: options.csp ?? {},
    networkWarned: false,
  };
  while (state.i < input.length && !state.stopped) {
    if (input[state.i] !== "<") {
      advance(state);
      continue;
    }
    const next = input[state.i + 1];
    if (next === "!") {
      if (input.startsWith("<!--", state.i)) consumeUntil(state, "-->", 4);
      else consumeUntilChar(state, ">");
      continue;
    }
    if (next === "?") {
      consumeUntilChar(state, ">");
      continue;
    }
    if (next === "/") {
      consumeTag(state, true);
      continue;
    }
    if (!isNameStart(next)) {
      advance(state);
      continue;
    }
    consumeTag(state, false);
  }
  sortOrigins(origins);
  return { ok: state.issues.length === 0, issues: state.issues, warnings: state.warnings, origins };
}

function tick(state: State): void {
  state.steps += 1;
  if (state.steps % 1024 !== 0) return;
  if (state.now() - state.started > state.budgetMs) {
    pushIssue(state, limitIssue("html_scan_timeout", "HTML scan exceeded its time limit"));
    state.stopped = true;
  }
}

function pushIssue(state: State, issue: ArtifactIssue): void {
  if (state.issues.length >= ISSUE_CAP) return;
  state.issues.push(issue);
}

function pushWarning(state: State, issue: ArtifactIssue): void {
  if (state.warnings.length >= ISSUE_CAP) return;
  state.warnings.push(issue);
}

function advance(state: State): void {
  tick(state);
  if (state.stopped || state.i >= state.input.length) return;
  const code = state.input.charCodeAt(state.i);
  noteByte(state, code);
  state.i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
}

function noteByte(state: State, code: number): void {
  if (code === 10) {
    state.lineBytes = 0;
    return;
  }
  state.lineBytes += utf8Len(code);
  if (state.lineBytes > HTML_SCAN_MAX_LINE_BYTES) {
    pushIssue(state, limitIssue("html_line_too_long", `line is longer than ${HTML_SCAN_MAX_LINE_BYTES} bytes`));
    state.stopped = true;
  }
}

function consumeUntil(state: State, needle: string, fromOffset: number): void {
  for (let step = 0; step < fromOffset && !state.stopped; step += 1) advance(state);
  const at = indexOfLiteral(state.input, needle, state.i);
  const end = at < 0 ? state.input.length : at + needle.length;
  while (state.i < end && !state.stopped) advance(state);
}

function consumeUntilChar(state: State, char: string): void {
  advance(state);
  while (state.i < state.input.length && !state.stopped && state.input[state.i] !== char) advance(state);
  if (!state.stopped && state.i < state.input.length) advance(state);
}

function indexOfLiteral(input: string, needle: string, from: number): number {
  return input.indexOf(needle, from);
}

function indexOfIgnoreCase(input: string, needle: string, from: number): number {
  const last = input.length - needle.length;
  const expect = needle.toLowerCase();
  for (let i = from; i <= last; i += 1) {
    let matched = true;
    for (let j = 0; j < expect.length; j += 1) {
      const found = input.charCodeAt(i + j);
      const folded = found >= 65 && found <= 90 ? found + 32 : found;
      if (folded !== expect.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function consumeTag(state: State, closing: boolean): void {
  const start = state.i;
  advance(state);
  if (closing) advance(state);
  const nameStart = state.i;
  if (state.i < state.input.length) advance(state);
  while (state.i < state.input.length && !state.stopped && isNameChar(state.input[state.i]!)) advance(state);
  if (state.stopped) return;
  const name = state.input.slice(nameStart, state.i).toLowerCase();
  if (!closing) {
    state.elements += 1;
    if (state.elements > HTML_SCAN_MAX_ELEMENTS) {
      pushIssue(state, limitIssue("html_too_many_elements", `document has more than ${HTML_SCAN_MAX_ELEMENTS} elements`));
      state.stopped = true;
      return;
    }
  }
  const attrs: Array<{ name: string; value: string | null }> = [];
  let closed = false;
  while (state.i < state.input.length && !state.stopped) {
    while (state.i < state.input.length && !state.stopped && isWs(state.input[state.i]!)) advance(state);
    if (state.stopped || state.i >= state.input.length) break;
    const char = state.input[state.i]!;
    if (char === ">") {
      advance(state);
      closed = true;
      break;
    }
    if (char === "/" && state.input[state.i + 1] === ">") {
      advance(state);
      advance(state);
      closed = true;
      break;
    }
    if (!isAttrStart(char)) {
      advance(state);
      continue;
    }
    const attr = readAttr(state);
    if (attr && !closing && KEPT_ATTRS.has(attr.name)) attrs.push(attr);
  }
  if (!closed || state.stopped || closing) {
    if (state.i === start) state.i += 1;
    return;
  }
  const index = state.counts.get(name) ?? 0;
  state.counts.set(name, index + 1);
  inspectTag(state, name, index, attrs);
  if (!state.stopped && RAW_TAGS.has(name) && !attrsSelfClose(state, start)) {
    consumeRaw(state, name);
  }
}

function attrsSelfClose(state: State, start: number): boolean {
  const end = state.i;
  return end - start >= 2 && state.input[end - 2] === "/" && state.input[end - 1] === ">";
}

function readAttr(state: State): { name: string; value: string | null } | undefined {
  const nameStart = state.i;
  advance(state);
  while (state.i < state.input.length && !state.stopped && isAttrChar(state.input[state.i]!)) advance(state);
  if (state.stopped) return undefined;
  const name = state.input.slice(nameStart, state.i).toLowerCase();
  while (state.i < state.input.length && !state.stopped && isWs(state.input[state.i]!)) advance(state);
  if (state.stopped || state.input[state.i] !== "=") return { name, value: null };
  advance(state);
  while (state.i < state.input.length && !state.stopped && isWs(state.input[state.i]!)) advance(state);
  if (state.stopped || state.i >= state.input.length) return { name, value: null };
  const quote = state.input[state.i];
  if (quote === '"' || quote === "'") {
    advance(state);
    const value = readValue(state, quote);
    return { name, value };
  }
  const value = readValue(state, undefined);
  return { name, value };
}

function readValue(state: State, quote: string | undefined): string | null {
  let value = "";
  let bytes = 0;
  let tooLong = false;
  while (state.i < state.input.length && !state.stopped) {
    const char = state.input[state.i]!;
    if (quote === undefined && (isWs(char) || char === ">")) break;
    if (quote !== undefined && char === quote) {
      advance(state);
      break;
    }
    tick(state);
    if (state.stopped) return null;
    const code = state.input.charCodeAt(state.i);
    const width = utf8Len(code);
    bytes += width;
    if (bytes > HTML_SCAN_MAX_ATTR_BYTES) {
      tooLong = true;
      value = "";
    } else if (!tooLong) {
      value += char;
    }
    noteByte(state, code);
    state.i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    if (state.stopped) return null;
  }
  if (tooLong) {
    pushIssue(state, limitIssue("html_attr_too_long", `attribute value is longer than ${HTML_SCAN_MAX_ATTR_BYTES} bytes`));
    state.stopped = true;
    return null;
  }
  return value;
}

function consumeRaw(state: State, name: string): void {
  const end = indexOfIgnoreCase(state.input, `</${name}`, state.i);
  const rawEnd = end < 0 ? state.input.length : end;
  const from = state.i;
  if (name === "script") noteNetwork(state, from, rawEnd);
  if (name === "style") scanCssRange(state, from, rawEnd, `style[${(state.counts.get("style") ?? 1) - 1}].url`, "style");
  while (state.i < rawEnd && !state.stopped) advance(state);
  if (state.stopped || end < 0) return;
  consumeTag(state, true);
}

function noteNetwork(state: State, from: number, to: number): void {
  if (state.networkWarned) return;
  const connect = state.csp.connectDomains ?? [];
  if (connect.length > 0) return;
  const slice = state.input.slice(from, to);
  if (!NETWORK_NEEDLES.some((needle) => slice.includes(needle))) return;
  state.networkWarned = true;
  pushWarning(state, {
    path: "script",
    code: "html_connect_warning",
    message: "script uses the network but connectDomains is empty: requests will be blocked",
  });
}

function inspectTag(state: State, name: string, index: number, attrs: Array<{ name: string; value: string | null }>): void {
  const pathFor = (attr: string) => `${name}[${index}].${attr}`;
  const attr = (attrName: string) => attrs.find((item) => item.name === attrName)?.value ?? undefined;
  const style = attr("style");
  if (style !== undefined && style.length > 0) scanCssText(state, style, pathFor("style"), "style");
  if (name === "body" || name === "table" || name === "td" || name === "th" || name === "tr") {
    const background = attr("background");
    if (background !== undefined) considerUrl(state, background, "resourceDomains", "img", pathFor("background"), "img");
  }
  if (name === "input" && (attr("type") ?? "").trim().toLowerCase() === "image") {
    const src = attr("src");
    if (src !== undefined) considerUrl(state, src, "resourceDomains", "img", pathFor("src"), "img");
  }
  if (name === "meta" && (attr("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
    pushIssue(state, cspIssue(pathFor("content"), "meta refresh is not allowed"));
    return;
  }
  if (name === "form") {
    pushIssue(state, cspIssue(attrs.some((item) => item.name === "action") ? pathFor("action") : pathFor("action"), "form actions are disabled"));
  }
  for (const item of attrs) {
    if (item.name === "formaction") pushIssue(state, cspIssue(pathFor("formaction"), "form actions are disabled"));
  }
  if (name === "form") return;
  if (name === "a" || name === "area") {
    const href = attr("href");
    if (href !== undefined && href.trim() !== "" && !href.trim().startsWith("#")) {
      pushWarning(state, {
        path: pathFor("href"),
        code: "html_link_warning",
        message: "links are disabled in the preview",
      });
    }
  }
  if (name === "base") {
    const href = attr("href");
    if (href !== undefined) considerUrl(state, href, "baseUriDomains", "base", pathFor("href"), "base");
    return;
  }
  if (name === "script") {
    const src = attr("src");
    if (src !== undefined) {
      considerUrl(state, src, "resourceDomains", "script", pathFor("src"), "script");
      requireExternalSri(state, src, attrs, pathFor("src"));
    }
    return;
  }
  if (name === "link") {
    const href = attr("href");
    const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const as = (attr("as") ?? "").toLowerCase();
    if (href !== undefined) {
      const connect = rel.includes("preconnect") || rel.includes("dns-prefetch");
      const list: HtmlCspListName = connect ? "connectDomains" : "resourceDomains";
      const bucket: Bucket = connect ? "connect" : linkBucket(rel, as);
      considerUrl(state, href, list, bucket, pathFor("href"), connect ? "connect" : "resource");
      if (rel.includes("stylesheet")) requireExternalSri(state, href, attrs, pathFor("href"));
    }
    const imagesrcset = attr("imagesrcset");
    if (imagesrcset !== undefined) {
      for (const candidate of srcsetCandidates(imagesrcset)) {
        considerUrl(state, candidate, "resourceDomains", "img", pathFor("imagesrcset"), "img");
      }
    }
    return;
  }
  if (name === "img") {
    const src = attr("src");
    if (src !== undefined) considerUrl(state, src, "resourceDomains", "img", pathFor("src"), "img");
    const srcset = attr("srcset");
    if (srcset !== undefined) {
      for (const candidate of srcsetCandidates(srcset)) {
        considerUrl(state, candidate, "resourceDomains", "img", pathFor("srcset"), "img");
      }
    }
    return;
  }
  if (name === "source" || name === "video" || name === "audio" || name === "track") {
    const src = attr("src");
    if (src !== undefined) considerUrl(state, src, "resourceDomains", "media", pathFor("src"), "media");
    const srcset = attr("srcset");
    if (srcset !== undefined) {
      for (const candidate of srcsetCandidates(srcset)) {
        considerUrl(state, candidate, "resourceDomains", "media", pathFor("srcset"), "media");
      }
    }
    if (name === "video") {
      const poster = attr("poster");
      if (poster !== undefined) considerUrl(state, poster, "resourceDomains", "img", pathFor("poster"), "img");
    }
    return;
  }
  if (name === "iframe" || name === "frame" || name === "object" || name === "embed") {
    pushIssue(state, cspIssue(`${name}[${index}]`, "embedded frames and objects are not allowed"));
    return;
  }
  if (name === "use" || name === "image" || name === "feimage") {
    const href = attr("href") ?? attr("xlink:href");
    const attrName = attr("href") !== undefined ? "href" : "xlink:href";
    if (href !== undefined) considerUrl(state, href, "resourceDomains", "img", pathFor(attrName), "img");
  }
}

function linkBucket(rel: string[], as: string): Bucket {
  if (as === "font" || rel.includes("icon") || rel.some((item) => item.includes("icon"))) return as === "font" ? "font" : "img";
  if (as === "script" || rel.includes("modulepreload")) return "script";
  if (as === "image") return "img";
  if (as === "font") return "font";
  return "style";
}

function srcsetCandidates(value: string): string[] {
  const parts = value.split(",");
  const out: string[] = [];
  for (const part of parts) {
    const url = part.trim().split(/\s+/)[0] ?? "";
    if (url.length > 0) out.push(url);
  }
  return out;
}

function scanCssRange(state: State, from: number, to: number, path: string, bucket: Bucket): void {
  scanCssText(state, state.input.slice(from, to), path, bucket);
}

function scanCssText(state: State, css: string, path: string, bucket: Bucket): void {
  const prepared = prepareCss(css);
  let i = 0;
  while (i < prepared.length && !state.stopped) {
    if (i % 1024 === 0) tick(state);
    const char = prepared[i]!;
    if (char === '"' || char === "'") {
      const quoted = readCssQuote(prepared, i);
      i = quoted ? quoted.end : i + 1;
      continue;
    }
    if (identBoundary(prepared, i) && startsWithIgnoreCase(prepared, "@import", i) && identBoundary(prepared, i + "@import".length + 1)) {
      i = consumeImport(state, prepared, i + "@import".length, path, bucket);
      continue;
    }
    const fn = cssFunctionAt(prepared, i);
    if (fn === "url") {
      const read = readCssUrl(prepared, i);
      if (read) {
        considerUrl(state, read.url, "resourceDomains", bucket, path, "style");
        i = read.end;
        continue;
      }
    } else if (fn) {
      const open = indexOfChar(prepared, "(", i);
      if (open < 0) break;
      i = consumeUrlList(state, prepared, open + 1, path, bucket);
      continue;
    }
    i += 1;
  }
}

function prepareCss(css: string): string {
  const out: string[] = [];
  let i = 0;
  let quote = "";
  while (i < css.length) {
    if (!quote && css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    const char = css[i]!;
    if (char === "\\") {
      const decoded = decodeCssEscape(css, i);
      out.push(decoded.text);
      i = decoded.end;
      continue;
    }
    if (quote && char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    out.push(char);
    i += 1;
  }
  return out.join("");
}

function decodeCssEscape(css: string, slash: number): { text: string; end: number } {
  let i = slash + 1;
  if (i >= css.length) return { text: "", end: css.length };
  if (isHex(css.charCodeAt(i))) {
    let value = 0;
    let count = 0;
    while (i < css.length && count < 6 && isHex(css.charCodeAt(i))) {
      value = (value << 4) + hexValue(css.charCodeAt(i));
      i += 1;
      count += 1;
    }
    if (i < css.length && isWs(css[i]!)) {
      if (css[i] === "\r" && css[i + 1] === "\n") i += 2;
      else i += 1;
    }
    if (value <= 0 || value > 0x10ffff) return { text: "\uFFFD", end: i };
    return { text: String.fromCodePoint(value), end: i };
  }
  if (css[i] === "\r" && css[i + 1] === "\n") return { text: "", end: i + 2 };
  if (css[i] === "\n" || css[i] === "\r" || css[i] === "\f") return { text: "", end: i + 1 };
  const text = css[i]!;
  return { text, end: i + 1 };
}

function isHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  return code - 87;
}

function identBoundary(css: string, index: number): boolean {
  if (index <= 0 || index > css.length) return true;
  const prev = css.charCodeAt(index - 1);
  return !((prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 45 || prev === 95);
}

function cssFunctionAt(css: string, index: number): "url" | "image-set" | "src" | "image" | null {
  if (!identBoundary(css, index)) return null;
  const names = ["image-set", "url", "src", "image"] as const;
  for (const name of names) {
    if (!startsWithIgnoreCase(css, name, index)) continue;
    let i = index + name.length;
    while (i < css.length && isWs(css[i]!)) i += 1;
    if (css[i] === "(" && identBoundary(css, index + name.length + 1)) return name;
  }
  return null;
}

function indexOfChar(css: string, char: string, from: number): number {
  for (let i = from; i < css.length; i += 1) if (css[i] === char) return i;
  return -1;
}

function consumeImport(state: State, css: string, from: number, path: string, bucket: Bucket): number {
  let i = from;
  while (i < css.length && isWs(css[i]!)) i += 1;
  if (cssFunctionAt(css, i) === "url") {
    const read = readCssUrl(css, i);
    if (read) {
      considerUrl(state, read.url, "resourceDomains", bucket, path, "style");
      return read.end;
    }
  }
  if (css[i] === '"' || css[i] === "'") {
    const quoted = readCssQuote(css, i);
    if (quoted) {
      considerUrl(state, quoted.url, "resourceDomains", bucket, path, "style");
      return quoted.end;
    }
  }
  const start = i;
  while (i < css.length && !isWs(css[i]!) && css[i] !== ";") i += 1;
  const token = css.slice(start, i).trim();
  if (token.length > 0) considerUrl(state, token, "resourceDomains", bucket, path, "style");
  return i;
}

function looksLikeUrlToken(token: string): boolean {
  if (token.length === 0 || /^[0-9]+(?:\.[0-9]+)?x$/i.test(token)) return false;
  return token.includes(":") || token.includes("/") || token.includes(".");
}

function consumeUrlList(state: State, css: string, from: number, path: string, bucket: Bucket): number {
  let i = from;
  let depth = 1;
  while (i < css.length && depth > 0 && !state.stopped) {
    const char = css[i]!;
    if (depth === 1 && (char === '"' || char === "'")) {
      const quoted = readCssQuote(css, i);
      if (!quoted) return css.length;
      considerUrl(state, quoted.url, "resourceDomains", bucket, path, "style");
      i = quoted.end;
      continue;
    }
    if (depth === 1 && cssFunctionAt(css, i) === "url") {
      const read = readCssUrl(css, i);
      if (!read) return css.length;
      considerUrl(state, read.url, "resourceDomains", bucket, path, "style");
      i = read.end;
      continue;
    }
    if (depth === 1 && char !== "," && char !== ")" && !isWs(char) && char !== "(") {
      const start = i;
      while (i < css.length && !isWs(css[i]!) && css[i] !== "," && css[i] !== "(" && css[i] !== ")") i += 1;
      const token = css.slice(start, i);
      if (looksLikeUrlToken(token)) considerUrl(state, token, "resourceDomains", bucket, path, "style");
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function startsWithIgnoreCase(input: string, needle: string, from: number): boolean {
  if (from + needle.length > input.length) return false;
  for (let j = 0; j < needle.length; j += 1) {
    const found = input.charCodeAt(from + j);
    const folded = found >= 65 && found <= 90 ? found + 32 : found;
    if (folded !== needle.charCodeAt(j)) return false;
  }
  return true;
}

function readCssUrl(css: string, from: number): { url: string; end: number } | undefined {
  let i = from + 3;
  while (i < css.length && isWs(css[i]!)) i += 1;
  if (css[i] !== "(") return undefined;
  i += 1;
  while (i < css.length && isWs(css[i]!)) i += 1;
  if (i >= css.length) return undefined;
  if (css[i] === '"' || css[i] === "'") {
    const quoted = readCssQuote(css, i);
    if (!quoted) return undefined;
    let end = quoted.end;
    while (end < css.length && css[end] !== ")") end += 1;
    return { url: quoted.url, end: end < css.length ? end + 1 : end };
  }
  const start = i;
  while (i < css.length && css[i] !== ")") i += 1;
  return { url: css.slice(start, i).trim(), end: i < css.length ? i + 1 : i };
}

function readCssQuote(css: string, from: number): { url: string; end: number } | undefined {
  const quote = css[from];
  if (quote !== '"' && quote !== "'") return undefined;
  let i = from + 1;
  while (i < css.length && css[i] !== quote) i += 1;
  if (i >= css.length) return { url: css.slice(from + 1), end: css.length };
  return { url: css.slice(from + 1, i), end: i + 1 };
}

type UrlKind = "script" | "embed" | "img" | "media" | "style" | "base" | "frame" | "connect" | "resource";

const SRI_VALUE = /^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}(?: (?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})*$/;
const EXTERNAL_SRI_MESSAGE = "external scripts and stylesheets need an integrity hash and crossorigin=anonymous";

function requireExternalSri(
  state: State,
  raw: string,
  attrs: Array<{ name: string; value: string | null }>,
  path: string,
): void {
  const classified = classifyUrl(raw);
  if (classified.kind !== "origin" || !classified.origin.startsWith("https://")) return;
  const integrity = attrs.find((item) => item.name === "integrity")?.value;
  const cross = attrs.find((item) => item.name === "crossorigin");
  const crossValue = cross ? (cross.value ?? "").trim().toLowerCase() : null;
  const crossOk = crossValue === "" || crossValue === "anonymous";
  const integrityOk = typeof integrity === "string" && SRI_VALUE.test(integrity.trim());
  if (!crossOk || !integrityOk) pushIssue(state, cspIssue(path, EXTERNAL_SRI_MESSAGE));
}

function considerUrl(
  state: State,
  raw: string,
  list: HtmlCspListName,
  bucket: Bucket,
  path: string,
  kind: UrlKind,
): void {
  const classified = classifyUrl(raw);
  if (classified.kind === "empty") return;
  if (classified.kind === "relative") {
    pushIssue(state, cspIssue(path, "relative URLs cannot be resolved inside a sandboxed document"));
    return;
  }
  if (classified.kind === "javascript" || classified.kind === "data" || classified.kind === "blob") {
    if (classified.kind === "data" && (kind === "img" || kind === "media" || kind === "style")) return;
    const label = classified.kind === "javascript" ? "javascript:" : classified.kind === "data" ? "data:" : "blob:";
    pushIssue(state, cspIssue(path, `${label} URLs are not allowed`));
    return;
  }
  rememberOrigin(state, bucket, classified.origin);
  const declared = state.csp[list];
  if (cspOriginCovers(declared, classified.origin)) return;
  pushIssue(state, cspIssue(path, `origin ${classified.origin} is not declared in ${list}`));
}

function cspIssue(path: string, message: string): ArtifactIssue {
  return { path, code: "html_csp_violation", message };
}

function rememberOrigin(state: State, bucket: Bucket, origin: string): void {
  const list = state.origins[bucket];
  if (list.length >= ISSUE_CAP || list.includes(origin)) return;
  list.push(origin);
}

function sortOrigins(origins: HtmlScanOrigins): void {
  for (const key of Object.keys(origins) as Bucket[]) origins[key].sort();
}

function decodeEntities(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "&") {
      out += value[i];
      continue;
    }
    const semi = value.indexOf(";", i + 1);
    if (semi < 0 || semi - i > 31) {
      out += "&";
      continue;
    }
    const decoded = decodeEntity(value.slice(i + 1, semi));
    if (decoded === undefined) {
      out += "&";
      continue;
    }
    out += decoded;
    i = semi;
  }
  return out;
}

function decodeEntity(body: string): string | undefined {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":" };
  const lower = body.toLowerCase();
  if (named[lower]) return named[lower];
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const code = Number.parseInt(body.slice(2), 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
    return String.fromCodePoint(code);
  }
  if (body.startsWith("#")) {
    const code = Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
    return String.fromCodePoint(code);
  }
  return undefined;
}

type Classified =
  | { kind: "empty" }
  | { kind: "relative" }
  | { kind: "javascript" }
  | { kind: "data" }
  | { kind: "blob" }
  | { kind: "origin"; origin: string };

export function classifyReference(raw: string): Classified {
  return classifyUrl(raw);
}

function classifyUrl(raw: string): Classified {
  const compact = decodeEntities(raw).replace(/[\u0000-\u0020]+/g, "");
  if (compact.length === 0 || compact.startsWith("#")) return { kind: "empty" };
  const lower = compact.toLowerCase();
  if (lower.startsWith("javascript:")) return { kind: "javascript" };
  if (lower.startsWith("data:")) return { kind: "data" };
  if (lower.startsWith("blob:")) return { kind: "blob" };
  if (lower.startsWith("//")) {
    const origin = originFromAuthority("https", compact.slice(2));
    return origin ? { kind: "origin", origin } : { kind: "relative" };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return { kind: "relative" };
  const name = scheme[1]!.toLowerCase();
  if (name !== "http" && name !== "https") return { kind: "relative" };
  const rest = compact.slice(scheme[0].length);
  if (!rest.startsWith("//")) return { kind: "relative" };
  const origin = originFromAuthority(name, rest.slice(2));
  return origin ? { kind: "origin", origin } : { kind: "relative" };
}

function originFromAuthority(scheme: string, authorityAndMore: string): string | undefined {
  let auth = authorityAndMore;
  const cut = auth.search(/[/?#\\]/);
  if (cut >= 0) auth = auth.slice(0, cut);
  if (auth.length === 0) return undefined;
  const at = auth.lastIndexOf("@");
  if (at >= 0) auth = auth.slice(at + 1);
  let host = auth;
  let port = "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end < 0 ? host : host.slice(1, end);
    const rest = end < 0 ? "" : auth.slice(end + 1);
    if (rest.startsWith(":")) port = rest.slice(1);
    host = host.toLowerCase();
    return port && port !== "443" ? `${scheme}://[${host}]:${port}` : `${scheme}://[${host}]`;
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0 && host.indexOf(":") === colon) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  if (!/^[0-9]*$/.test(port)) return `${scheme}://${host}`;
  return port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}

const LIMIT_CODES = new Set([
  "html_document_too_large",
  "html_line_too_long",
  "html_attr_too_long",
  "html_too_many_elements",
  "html_scan_timeout",
]);

export async function assertHtmlDocumentAtPublish(html: string, csp: HtmlCsp): Promise<ArtifactIssue[]> {
  return withArtifactValidation(async () => {
    const scan = scanHtml(html, { csp });
    if (!scan.ok) {
      const limited = scan.issues.some((issue) => issue.code !== undefined && LIMIT_CODES.has(issue.code));
      const tooLarge = scan.issues.some((issue) => issue.code === "html_document_too_large");
      const code = limited ? (tooLarge ? "artifact.too_large" : "artifact.invalid_shape") : "artifact.html_csp_violation";
      const status = tooLarge ? 413 : 400;
      throw new ArtifactPublishError(status, code, scan.issues[0]?.message ?? "HTML document was rejected", scan.issues);
    }
    return scan.warnings;
  });
}
