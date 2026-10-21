import type {
  McpOAuthStatus,
  McpSecretsList,
  ProjectMcpImportResult,
  ProjectMcpRowStatus,
  ProjectMcpServerConfig,
} from "../../api";

export type McpKv = { key: string; value: string };

export type McpAuthMode = "none" | "bearer" | "headers";

export type McpFormState = {
  name: string;
  transport: "stdio" | "http";
  /** stdio: the command and its arguments on one line, e.g. `npx -y @scope/server`. */
  commandLine: string;
  env: McpKv[];
  url: string;
  /** http: `auto` tries streamable HTTP and falls back to SSE; `sse` pins SSE. */
  httpTransport: "auto" | "sse";
  authMode: McpAuthMode;
  /** A token typed in the form; saved as a secret, never kept in the file. */
  bearerToken: string;
  /** Name of the secret an existing `Bearer ${NAME}` header points at. */
  bearerRef: string | null;
  headers: McpKv[];
};

export function emptyMcpForm(): McpFormState {
  return {
    name: "",
    transport: "stdio",
    commandLine: "",
    env: [],
    url: "",
    httpTransport: "auto",
    authMode: "none",
    bearerToken: "",
    bearerRef: null,
    headers: [],
  };
}

/** Header/env names whose values are credentials: shown masked, never echoed in clear. */
export function looksSecretKey(key: string): boolean {
  return /authorization|token|secret|key|password/i.test(key);
}

const PLACEHOLDER_ONLY = /^(?:Bearer\s+)?(?:\$\{[^}]*\}\s*)*$/i;

/** A value input is masked when its key looks secret and the value is a literal, not a `${NAME}` reference. */
export function shouldMaskValue(key: string, value: string): boolean {
  if (!looksSecretKey(key) && !/^\s*authorization\s*:/i.test(value)) return false;
  return !PLACEHOLDER_ONLY.test(value.trim());
}

/** The name field holds a pasted `Authorization: Bearer <token>` line: mask it too. */
export function shouldMaskKey(key: string): boolean {
  return /^\s*authorization\s*:\s*\S/i.test(key);
}

/**
 * Pasting a whole `Name: value` header into either box still saves as a header: the line is split
 * here, and the host moves a literal token into secrets.
 */
export function normalizeHeaderRow(row: McpKv): McpKv {
  const inKey = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(row.key);
  if (inKey && row.value.trim() === "") return { key: inKey[1]!, value: inKey[2]!.trim() };
  const inValue = /^\s*authorization\s*:\s*(.+)$/i.exec(row.value);
  if (inValue && (row.key.trim() === "" || /^authorization$/i.test(row.key.trim()))) {
    return { key: "Authorization", value: inValue[1]!.trim() };
  }
  return row;
}

function kvToRecord(rows: readonly McpKv[], headers = false): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of rows) {
    const row = headers ? normalizeHeaderRow(raw) : raw;
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function recordToKv(record: Record<string, string> | undefined): McpKv[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

/** Split a command line like a shell would for quotes: `npx -y "my server"` -> 3 words. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current) words.push(current);
  return words;
}

export function joinCommandLine(command: string, args: readonly string[]): string {
  const quote = (w: string) => (w === "" || /[\s"'\\]/.test(w) ? `"${w.replace(/(["\\])/g, "\\$1")}"` : w);
  return [command, ...args].map(quote).join(" ");
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BEARER_REF = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type McpFormResult =
  | { ok: true; name: string; config: ProjectMcpServerConfig }
  | { ok: false; error: string };

export function formToConfig(form: McpFormState): McpFormResult {
  const name = form.name.trim();
  if (!NAME.test(name)) {
    return { ok: false, error: "Name: letters, digits, '.', '_' or '-' (up to 64)." };
  }
  if (form.transport === "stdio") {
    const [command, ...args] = splitCommandLine(form.commandLine);
    if (!command) return { ok: false, error: "Command is required, e.g. npx -y @scope/server." };
    const env = kvToRecord(form.env);
    return {
      ok: true,
      name,
      config: { command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) },
    };
  }
  const url = form.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "URL must start with http:// or https://." };
  }
  const base: ProjectMcpServerConfig = {
    url,
    ...(form.httpTransport === "sse" ? { httpTransport: "sse" as const } : {}),
  };
  if (form.authMode === "bearer") {
    const token = form.bearerToken.trim().replace(/^(?:authorization\s*:\s*)?Bearer\s+/i, "");
    if (token) return { ok: true, name, config: { ...base, headers: { Authorization: `Bearer ${token}` } } };
    if (form.bearerRef) {
      return { ok: true, name, config: { ...base, headers: { Authorization: `Bearer \${${form.bearerRef}}` } } };
    }
    return { ok: false, error: "Paste the token this server expects." };
  }
  const headers = form.authMode === "headers" ? kvToRecord(form.headers, true) : undefined;
  return { ok: true, name, config: { ...base, ...(headers ? { headers } : {}) } };
}

export function configToForm(name: string, config: ProjectMcpServerConfig): McpFormState {
  const headers = config.headers ?? {};
  const keys = Object.keys(headers);
  const auth = keys.length === 1 && keys[0]!.toLowerCase() === "authorization" ? headers[keys[0]!] : undefined;
  const ref = auth !== undefined ? BEARER_REF.exec(auth)?.[1] : undefined;
  return {
    name,
    transport: config.url !== undefined ? "http" : "stdio",
    commandLine: config.command !== undefined ? joinCommandLine(config.command, config.args ?? []) : "",
    env: recordToKv(config.env),
    url: config.url ?? "",
    httpTransport: config.httpTransport === "sse" ? "sse" : "auto",
    authMode: ref ? "bearer" : keys.length > 0 ? "headers" : "none",
    bearerToken: "",
    bearerRef: ref ?? null,
    headers: recordToKv(config.headers),
  };
}

export type PasteResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Pasted text must be a JSON object; the server decides which shape it is. */
export function parsePastedMcp(text: string): PasteResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste a JSON snippet first." };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "The JSON must be an object." };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
}

export function secretsSummary(stored: readonly string[]): string | null {
  if (stored.length === 0) return null;
  const unique = [...new Set(stored)];
  return `Moved ${unique.length === 1 ? "a token" : `${unique.length} tokens`} out of the config into secrets: ${unique.join(", ")}.`;
}

/** Notice shown after a save; null when nothing was moved into secrets. */
export function saveNotice(res: { secretsStored: readonly string[] }): string | null {
  return secretsSummary(res.secretsStored);
}

export type ImportOutcome = { ok: true; notice: string | null } | { ok: false; error: string };

/** An import that added nothing is a failure; skipped entries are listed in the notice. */
export function importOutcome(res: ProjectMcpImportResult): ImportOutcome {
  if (res.added.length === 0) {
    return { ok: false, error: res.errors.map((e) => `${e.name}: ${e.error}`).join(" · ") || "Nothing was added." };
  }
  const skipped =
    res.errors.length > 0 ? `Skipped: ${res.errors.map((e) => `${e.name} (${e.error})`).join(", ")}.` : "";
  return { ok: true, notice: [secretsSummary(res.secretsStored), skipped].filter(Boolean).join(" ") || null };
}

export function deleteNotice(name: string): string {
  return `Removed ${name}.`;
}

export function signedInNotice(name: string): string {
  return `Signed in to ${name}.`;
}

export function isSignedIn(oauth: McpOAuthStatus | undefined): boolean {
  return oauth === "authenticated";
}

/** Sign in is offered for remote servers that asked for it (probe said so, or a stored token expired). */
export function canSignIn(
  row: { transport: "stdio" | "http"; status: ProjectMcpRowStatus },
  oauth: McpOAuthStatus | undefined,
): boolean {
  return row.transport === "http" && !isSignedIn(oauth) && (row.status === "needs_auth" || oauth === "expired");
}

export type SecretRowLabel = "stored" | "set on the Host" | "missing";
export type SecretRow = { name: string; usedBy: string[]; stored: boolean; label: SecretRowLabel };

/** Needed placeholders first, then stored values nothing references. */
export function secretRows(secrets: McpSecretsList): SecretRow[] {
  const stored = new Set(secrets.secrets.map((s) => s.name));
  const row = (name: string, usedBy: string[], set: boolean): SecretRow => ({
    name,
    usedBy,
    stored: stored.has(name),
    label: set ? (stored.has(name) ? "stored" : "set on the Host") : "missing",
  });
  return [
    ...secrets.needed.map((n) => row(n.name, n.usedBy, n.set)),
    ...secrets.secrets.filter((s) => !secrets.needed.some((n) => n.name === s.name)).map((s) => row(s.name, s.usedBy, true)),
  ];
}

export function secretRowDetail(row: SecretRow): string {
  return `${row.usedBy.length > 0 ? `used by ${row.usedBy.join(", ")}` : "not used by any server"} · ${row.label}`;
}
