/**
 * One place that knows every secret-bearing location of an MCP server entry:
 * env values, header values, URL userinfo and query params, and args like `--token=...`.
 *
 * Three views of the same entry:
 * - stored:   `extractSecrets` moves literal tokens out into a secrets map and leaves `${NAME}`.
 * - shown:    `maskEntry` is what the console reads back; literals become "••••".
 * - scrubbed: `scrubText` removes secret values from error text.
 *
 * Also hosts the URL policy (`assertSafeMcpUrl`) so save, probe, OAuth and resolve share it.
 */

export const MASK = "••••";
const MIN_SCRUB_LENGTH = 6;

/** Keys that carry a literal secret in env/headers/query/args. */
export const SECRET_KEY =
  /token|secret|password|passwd|api[-_]?key|auth|credential|bearer|private[-_]?key/i;
const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|AIza|glpat-|npm_|pk_live_|sk_live_|ya29\.)/;
const AUTH_PREFIX = /^(?:Bearer|Basic|Token)\s+/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function literalLooksSecret(key: string, value: string): boolean {
  if (value.length === 0 || value.includes("${")) return false;
  const bare = value.replace(AUTH_PREFIX, "");
  if (TOKEN_PREFIX.test(bare)) return true;
  if (SECRET_KEY.test(key)) return true;
  return (
    bare.length >= 32 &&
    /^[A-Za-z0-9_\-+/=.]+$/.test(bare) &&
    /\d/.test(bare) &&
    /[A-Za-z]/.test(bare)
  );
}

// ---------------------------------------------------------------- URL policy

export class McpUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUrlPolicyError";
  }
}

function ipv4Octets(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : undefined;
}

function mappedV4(host: string): number[] | undefined {
  // URL() normalises ::ffff:1.2.3.4 to ::ffff:102:304
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!m) return undefined;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * Link-local and cloud-metadata destinations are never a real MCP server and are the classic SSRF
 * target. Loopback and private LAN ranges stay allowed: local MCP servers are normal.
 */
export function isBlockedMcpHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (host === "metadata.google.internal" || host === "metadata") return true;
  const v4 = ipv4Octets(host) ?? mappedV4(host);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  if (host.includes(":")) {
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) return true; // fe80::/10
    if (/^fd00:0*ec2:(?:0*:)*0*:?0*254$/i.test(host) || host === "fd00:ec2::254") return true;
    if (/^fd00:ec2:/i.test(host) && /254$/.test(host)) return true;
  }
  return false;
}

/** Throws McpUrlPolicyError for an unusable or forbidden URL. Placeholder URLs are skipped. */
export function assertSafeMcpUrl(raw: string): void {
  if (raw.includes("${")) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpUrlPolicyError("\"url\" is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpUrlPolicyError("\"url\" must start with http:// or https://");
  }
  if (isBlockedMcpHost(parsed.hostname)) {
    throw new McpUrlPolicyError(
      "\"url\" points at a link-local or cloud-metadata address, which is not allowed",
    );
  }
}

// ----------------------------------------------------------- stored (extract)

export type SecretNamer = (key: string, value: string, taken: Record<string, string>) => string;

type Extractor = {
  taken: Record<string, string>;
  found: Record<string, string>;
  name: SecretNamer;
};

function take(ex: Extractor, key: string, value: string): string {
  const prefix = AUTH_PREFIX.exec(value)?.[0] ?? "";
  const bare = value.slice(prefix.length);
  const secretName = ex.name(key, bare, { ...ex.taken, ...ex.found });
  ex.found[secretName] = bare;
  return `${prefix}\${${secretName}}`;
}

function extractUrl(url: string, ex: Extractor): string {
  if (url.includes("${") && !/[?@]/.test(url)) return url;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const qAt = beforeHash.indexOf("?");
  let base = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  const query = qAt === -1 ? undefined : beforeHash.slice(qAt + 1);

  base = base.replace(/^(\w+:\/\/)([^/@]*)@/, (_m, scheme: string, info: string) => {
    const colon = info.indexOf(":");
    if (colon === -1) {
      return literalLooksSecret("token", info) && !info.includes("${")
        ? `${scheme}${take(ex, "token", info)}@`
        : `${scheme}${info}@`;
    }
    const user = info.slice(0, colon);
    const pass = info.slice(colon + 1);
    if (pass.length === 0 || pass.includes("${")) return `${scheme}${info}@`;
    return `${scheme}${user}:${take(ex, "password", decodeSafe(pass))}@`;
  });

  let out = base;
  if (query !== undefined) {
    const pairs = query.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = decodeSafe(pair.slice(0, eq));
      const value = decodeSafe(pair.slice(eq + 1));
      if (!literalLooksSecret(key, value)) return pair;
      return `${pair.slice(0, eq)}=${take(ex, key, value)}`;
    });
    out += `?${pairs.join("&")}`;
  }
  return out + hash;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractArgs(args: string[], ex: Extractor): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*)=([\s\S]*)$/.exec(arg);
    if (eq) {
      const [, flag, value] = eq as unknown as [string, string, string];
      if (literalLooksSecret(flag.replace(/^-+/, ""), value)) {
        out.push(`${flag}=${take(ex, flag.replace(/^-+/, ""), value)}`);
      } else {
        out.push(arg);
      }
      continue;
    }
    const flag = /^--?([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(arg);
    const next = args[i + 1];
    if (flag && next !== undefined && !next.startsWith("-") && literalLooksSecret(flag[1]!, next)) {
      out.push(arg, take(ex, flag[1]!, next));
      i += 1;
      continue;
    }
    if (TOKEN_PREFIX.test(arg.replace(AUTH_PREFIX, ""))) {
      out.push(take(ex, "token", arg));
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Move literal secrets out of a (validated) entry. Returns a new entry holding `${NAME}`
 * placeholders and the `{ NAME: value }` map to store.
 */
export function extractSecrets(
  entry: Record<string, unknown>,
  name: SecretNamer,
  taken: Record<string, string> = {},
): { entry: Record<string, unknown>; secrets: Record<string, string> } {
  const ex: Extractor = { taken, found: {}, name };
  const out: Record<string, unknown> = { ...entry };
  for (const key of ["env", "headers"] as const) {
    const bag = entry[key];
    if (!isPlainObject(bag)) continue;
    const copy: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(bag)) {
      copy[field] =
        typeof value === "string" && literalLooksSecret(field, value)
          ? take(ex, field, value)
          : value;
    }
    out[key] = copy;
  }
  if (typeof entry.url === "string") out.url = extractUrl(entry.url, ex);
  if (Array.isArray(entry.args)) out.args = extractArgs(entry.args as string[], ex);
  return { entry: out, secrets: ex.found };
}

// -------------------------------------------------------------- shown (mask)

function maskUrl(url: string): string {
  const { entry } = extractSecrets({ url }, (key, value) => {
    void value;
    return `__MASK_${key}`;
  });
  return String(entry.url)
    .replace(/\$\{__MASK_[^}]*\}/g, MASK);
}

function maskArgs(args: string[]): string[] {
  const { entry } = extractSecrets({ args }, (key) => `__MASK_${key}`);
  return (entry.args as string[]).map((a) => a.replace(/\$\{__MASK_[^}]*\}/g, MASK));
}

/** Read-back view: placeholders stay, literal secrets become "••••". Same JSON shape. */
export function maskEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  for (const key of ["env", "headers"] as const) {
    const bag = entry[key];
    if (!isPlainObject(bag)) continue;
    const copy: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(bag)) {
      if (typeof value === "string" && literalLooksSecret(field, value)) {
        copy[field] = `${AUTH_PREFIX.exec(value)?.[0] ?? ""}${MASK}`;
      } else {
        copy[field] = value;
      }
    }
    out[key] = copy;
  }
  if (typeof entry.url === "string") out.url = maskUrl(entry.url);
  if (Array.isArray(entry.args)) out.args = maskArgs(entry.args as string[]);
  return out;
}

// ----------------------------------------------------------- scrubbed (text)

/** Secret values carried by a RESOLVED entry (placeholders already filled). */
export function collectSecretValues(entry: Record<string, unknown>): string[] {
  const values = new Set<string>();
  const add = (v: string): void => {
    if (v.length < MIN_SCRUB_LENGTH) return;
    values.add(v);
    const enc = encodeURIComponent(v);
    if (enc !== v) values.add(enc);
  };
  for (const key of ["env", "headers"] as const) {
    const bag = entry[key];
    if (!isPlainObject(bag)) continue;
    for (const v of Object.values(bag)) {
      if (typeof v !== "string") continue;
      add(v);
      const bare = v.replace(AUTH_PREFIX, "");
      if (bare !== v) add(bare);
    }
  }
  if (typeof entry.url === "string") {
    const { secrets } = extractSecrets({ url: entry.url }, (k) => `S_${k}`);
    Object.values(secrets).forEach(add);
    // userinfo password even when it does not look token-like
    const info = /^\w+:\/\/([^/@]*)@/.exec(entry.url)?.[1];
    const pass = info?.includes(":") ? info.slice(info.indexOf(":") + 1) : undefined;
    if (pass) add(decodeSafe(pass));
    try {
      for (const [k, v] of new URL(entry.url).searchParams) if (SECRET_KEY.test(k)) add(v);
    } catch {
      /* not parseable: nothing more to collect */
    }
  }
  if (Array.isArray(entry.args)) {
    const { secrets } = extractSecrets({ args: entry.args }, (k) => `S_${k}`);
    Object.values(secrets).forEach(add);
  }
  return [...values];
}

/** Remove secret values from text. Values shorter than 6 chars are ignored on purpose. */
export function scrubText(text: string, secrets: Iterable<string>): string {
  let out = text;
  const list = [...secrets].filter((s) => s.length >= MIN_SCRUB_LENGTH);
  list.sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join("[redacted]");
  return out;
}

/** OAuth only needs the URL, transport and non-secret headers; drop the rest. */
export function oauthDefinition(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "env" || key === "command" || key === "args" || key === "cwd") continue;
    if (key === "headers" && isPlainObject(value)) {
      const kept = Object.fromEntries(
        Object.entries(value).filter(
          ([name, v]) => !SECRET_KEY.test(name) && !(typeof v === "string" && literalLooksSecret(name, v)),
        ),
      );
      if (Object.keys(kept).length > 0) out.headers = kept;
      continue;
    }
    out[key] = value;
  }
  return out;
}
