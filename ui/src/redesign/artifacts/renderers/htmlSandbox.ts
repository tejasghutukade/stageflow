export const STATIC_HTML_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

export const STATIC_HTML_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${STATIC_HTML_CSP}">`;

export const STATIC_HTML_DOCUMENT_START = `<!doctype html><html><head>${STATIC_HTML_CSP_META}</head><body>`;

const DISABLED_LINK_TITLE = "Link disabled in static preview";

const DROP_TAGS = new Set(["base", "iframe", "object", "embed"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const SVG_URL_TAGS = new Set(["use", "image", "feimage"]);

type Attr = { name: string; value: string | null };

type Tag = {
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Attr[];
};

type Scan =
  | { type: "advance" }
  | { type: "opaque"; end: number }
  | { type: "tag"; tag: Tag };

const ADVANCE: Scan = { type: "advance" };

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

function indexOfIgnoreCase(input: string, needle: string, from: number): number {
  const last = input.length - needle.length;
  for (let i = from; i <= last; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      const found = input.charCodeAt(i + j);
      const expected = needle.charCodeAt(j);
      if (found === expected) continue;
      if (found >= 65 && found <= 90 && found + 32 === expected) continue;
      matched = false;
      break;
    }
    if (matched) return i;
  }
  return -1;
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
      j += 1;
      continue;
    }
    if (state === "start-dash") {
      if (char === ">") return j + 1;
      state = char === "-" ? "end" : "comment";
      j += 1;
      continue;
    }
    if (state === "comment") {
      if (char === "-") state = "end-dash";
      j += 1;
      continue;
    }
    if (state === "end-dash") {
      state = char === "-" ? "end" : "comment";
      j += 1;
      continue;
    }
    if (state === "end") {
      if (char === ">") return j + 1;
      if (char === "!") state = "bang";
      else if (char !== "-") state = "comment";
      j += 1;
      continue;
    }
    if (char === ">") return j + 1;
    state = char === "-" ? "end-dash" : "comment";
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
  return { end, name, closing, selfClosing: input.slice(end - 2, end) === "/>", attrs };
}

function scanAt(input: string, lt: number): Scan {
  const next = input[lt + 1];
  if (next === undefined) return ADVANCE;
  if (next === "!") {
    if (input.startsWith("<!--", lt)) return { type: "opaque", end: scanCommentEnd(input, lt) };
    return { type: "opaque", end: scanToGt(input, lt + 2) };
  }
  if (next === "?") return { type: "opaque", end: scanToGt(input, lt + 2) };
  if (next === "/") {
    const nameStart = input[lt + 2];
    if (!isNameStart(nameStart)) return { type: "opaque", end: scanToGt(input, lt + 2) };
    const tag = parseTag(input, lt, true);
    if (!tag) return { type: "opaque", end: input.length };
    return { type: "tag", tag };
  }
  if (!isNameStart(next)) return ADVANCE;
  const tag = parseTag(input, lt, false);
  if (!tag) return { type: "opaque", end: input.length };
  return { type: "tag", tag };
}

export function linkHrefIsExternal(href: string): boolean {
  const value = href.trim();
  if (value.startsWith("//")) return true;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
  if (!match) return false;
  const scheme = match[1]!.toLowerCase();
  if (scheme === "data" || scheme === "blob") return false;
  return match[2]!.startsWith("//");
}

function isRefreshMeta(tag: Tag): boolean {
  return tag.attrs.some(
    (attr) => attr.name === "http-equiv" && (attr.value ?? "").trim().toLowerCase() === "refresh",
  );
}

function isExternalLink(tag: Tag): boolean {
  return tag.attrs.some((attr) => attr.name === "href" && attr.value !== null && linkHrefIsExternal(attr.value));
}

function shouldDrop(tag: Tag): boolean {
  if (DROP_TAGS.has(tag.name)) return true;
  if (tag.closing) return false;
  if (tag.name === "meta" && isRefreshMeta(tag)) return true;
  if (tag.name === "link" && isExternalLink(tag)) return true;
  return false;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function serializeOpenTag(name: string, attrs: Attr[], selfClosing: boolean): string {
  const rendered = attrs.map((attr) =>
    attr.value === null ? attr.name : `${attr.name}="${escapeAttr(attr.value)}"`,
  );
  const inner = rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
  return `<${name}${inner}${selfClosing ? " />" : ">"}`;
}

function keepsFragment(value: string | null): boolean {
  return (value ?? "").startsWith("#");
}

function isLinkAttr(name: string): boolean {
  return name === "href" || name === "xlink:href";
}

function rewriteUrls(input: string, tag: Tag, kind: "anchor" | "resource"): string | null {
  if (tag.closing) return null;
  let changed = false;
  let removedHref = false;
  let hasTitle = false;
  const attrs: Attr[] = [];
  for (const attr of tag.attrs) {
    if (kind === "anchor" && attr.name === "ping") {
      changed = true;
      continue;
    }
    if (attr.name === "title") hasTitle = true;
    if (isLinkAttr(attr.name) && !keepsFragment(attr.value)) {
      changed = true;
      removedHref = true;
      continue;
    }
    attrs.push(attr);
  }
  if (kind === "anchor" && removedHref && !hasTitle) {
    changed = true;
    attrs.push({ name: "title", value: DISABLED_LINK_TITLE });
  }
  if (!changed) return null;
  return serializeOpenTag(tag.name, attrs, input.slice(tag.end - 2, tag.end) === "/>");
}

function rawTextEnd(input: string, name: string, openTagEnd: number): number {
  const at = indexOfIgnoreCase(input, `</${name}`, openTagEnd);
  if (at === -1) return input.length;
  const gt = input.indexOf(">", at + name.length + 2);
  return gt === -1 ? input.length : gt + 1;
}

function neutralizeStaticHtml(input: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let i = 0;
  let svgDepth = 0;
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
    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      const rawEnd = rawTextEnd(input, tag.name, tag.end);
      const replacement = tag.name === "script" && svgDepth > 0 ? rewriteUrls(input, tag, "resource") : null;
      if (replacement !== null) {
        if (cursor < i) parts.push(input.slice(cursor, i));
        parts.push(replacement);
        if (tag.end < rawEnd) parts.push(input.slice(tag.end, rawEnd));
        cursor = rawEnd;
      }
      i = rawEnd;
      continue;
    }
    if (!tag.closing && tag.name === "svg" && !tag.selfClosing) svgDepth += 1;
    const replacement = shouldDrop(tag)
      ? ""
      : tag.name === "a" || tag.name === "area"
        ? rewriteUrls(input, tag, "anchor")
        : SVG_URL_TAGS.has(tag.name)
          ? rewriteUrls(input, tag, "resource")
          : null;
    if (shouldDrop(tag) || replacement !== null) {
      if (cursor < i) parts.push(input.slice(cursor, i));
      if (replacement) parts.push(replacement);
      cursor = tag.end;
    }
    if (tag.closing && tag.name === "svg" && svgDepth > 0) svgDepth -= 1;
    i = tag.end;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts.join("");
}

function stripLeadingHtmlDoctype(input: string): string {
  return input.replace(/^\s*<!doctype\s+html\s*>/i, "");
}

export function prepareStaticHtml(input: string): string {
  const bom = input.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const body = bom ? input.slice(1) : input;
  const neutralized = neutralizeStaticHtml(body);
  if (neutralized.startsWith(STATIC_HTML_DOCUMENT_START)) return bom + neutralized;
  return bom + STATIC_HTML_DOCUMENT_START + stripLeadingHtmlDoctype(neutralized);
}

export function isHtmlPreviewPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return ext === ".html" || ext === ".htm";
}
