import type { ProjectMcpServerConfig } from "../../api";

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

function kvToRecord(rows: readonly McpKv[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
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
    const token = form.bearerToken.trim().replace(/^Bearer\s+/i, "");
    if (token) return { ok: true, name, config: { ...base, headers: { Authorization: `Bearer ${token}` } } };
    if (form.bearerRef) {
      return { ok: true, name, config: { ...base, headers: { Authorization: `Bearer \${${form.bearerRef}}` } } };
    }
    return { ok: false, error: "Paste the token this server expects." };
  }
  const headers = form.authMode === "headers" ? kvToRecord(form.headers) : undefined;
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
