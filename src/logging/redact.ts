import { COMMON_WORDS } from "./commonWords.js";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b[A-Za-z_]*KEY[A-Za-z_]*\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?/gi,
];

const REDACTED = "[redacted]";

export type NamedSecret = { name: string; value: string };

export type RedactOptions = {
  patterns?: RegExp[];
  knownSecrets?: readonly string[];
  namedSecrets?: readonly NamedSecret[];
};

function shouldRegisterValue(value: string): boolean {
  if (value.length < 8) return false;
  const lower = value.toLowerCase();
  if (COMMON_WORDS.has(lower)) return false;
  return true;
}

function markerFor(name: string | undefined): string {
  return name !== undefined && name.length > 0
    ? `[redacted:${name}]`
    : REDACTED;
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0 || !haystack.includes(needle)) return haystack;
  return haystack.split(needle).join(replacement);
}

function scrubString(
  value: string,
  patterns: RegExp[],
  knownSecrets: readonly string[],
  namedSecrets: readonly NamedSecret[],
): string {
  let out = value;
  for (const pattern of patterns) {
    out = out.replace(pattern, REDACTED);
  }
  for (const named of namedSecrets) {
    if (!shouldRegisterValue(named.value)) continue;
    const marker = markerFor(named.name);
    out = replaceAll(out, named.value, marker);
    out = replaceAll(out, Buffer.from(named.value, "utf8").toString("base64"), marker);
    out = replaceAll(out, encodeURIComponent(named.value), marker);
  }
  for (const secret of knownSecrets) {
    if (secret.length === 0) continue;
    if (!out.includes(secret)) continue;
    out = replaceAll(out, secret, REDACTED);
  }
  return out;
}

function scrubValue(
  value: unknown,
  patterns: RegExp[],
  knownSecrets: readonly string[],
  namedSecrets: readonly NamedSecret[],
): unknown {
  if (typeof value === "string") {
    return scrubString(value, patterns, knownSecrets, namedSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      scrubValue(item, patterns, knownSecrets, namedSecrets),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = scrubValue(child, patterns, knownSecrets, namedSecrets);
    }
    return out;
  }
  return value;
}

export function redactString(
  text: string,
  options: RedactOptions = {},
): string {
  return scrubString(
    text,
    options.patterns ?? SECRET_PATTERNS,
    options.knownSecrets ?? [],
    options.namedSecrets ?? [],
  );
}

export function redact<T extends Record<string, unknown>>(
  record: T,
  options: RedactOptions = {},
): T {
  const patterns = options.patterns ?? SECRET_PATTERNS;
  const knownSecrets = options.knownSecrets ?? [];
  const namedSecrets = options.namedSecrets ?? [];
  return scrubValue(record, patterns, knownSecrets, namedSecrets) as T;
}

export function stripUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    return url.replace(/\/\/([^/@]+)@/g, "//");
  }
}
