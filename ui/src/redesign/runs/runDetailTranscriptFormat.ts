import type { ToolCallView } from "./runDetailTranscriptModel";
import { formatDuration } from "../../components/LogPanel";

const TOOL_LABEL_ARG: Record<string, { key: string; isPath: boolean }> = {
  read: { key: "file_path", isPath: true },
  write: { key: "file_path", isPath: true },
  edit: { key: "file_path", isPath: true },
  notebookedit: { key: "notebook_path", isPath: true },
  bash: { key: "command", isPath: false },
  grep: { key: "pattern", isPath: false },
  glob: { key: "pattern", isPath: false },
  webfetch: { key: "url", isPath: false },
  websearch: { key: "query", isPath: false },
};

function parseArgsPreview(
  argsPreview: string | undefined,
): Record<string, unknown> | undefined {
  if (!argsPreview) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsPreview);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractArgValue(
  argsPreview: string | undefined,
  key: string,
): string | undefined {
  const parsed = parseArgsPreview(argsPreview)?.[key];
  if (typeof parsed === "string") return parsed;
  if (!argsPreview) return undefined;
  const match = argsPreview.match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
  );
  return match ? match[1] : undefined;
}

function basename(value: string): string {
  return value.split("/").pop() || value;
}

export function toolCallArgSummary(call: ToolCallView): string {
  const mapping = TOOL_LABEL_ARG[call.name.toLowerCase()];
  if (!mapping) {
    if (call.args?.trim()) {
      const trimmed = call.args.trim();
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
    }
    return "";
  }
  const value = extractArgValue(call.args, mapping.key);
  if (typeof value !== "string" || !value.trim()) return "";
  const shown = mapping.isPath ? basename(value) : value;
  return shown.length > 120 ? `${shown.slice(0, 117)}…` : shown;
}

export function toolCallDurationMs(
  call: ToolCallView,
  now: number,
): number | undefined {
  if (!call.startedAt) return undefined;
  const start = Date.parse(call.startedAt);
  if (Number.isNaN(start)) return undefined;
  if (call.status === "running") return Math.max(0, now - start);
  if (!call.at) return undefined;
  const end = Date.parse(call.at);
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function formatToolCallDuration(
  call: ToolCallView,
  now: number,
): string | undefined {
  const ms = toolCallDurationMs(call, now);
  if (ms === undefined) return undefined;
  return formatDuration(ms);
}

export type ToolResultField = {
  label: string;
  value: string;
  href?: string;
};

export type ToolResultRow = {
  primary: string;
  secondary?: string;
  stat?: string;
};

export type ToolResultPresentation =
  | {
      kind: "card";
      headline: string;
      fields: ToolResultField[];
      prose?: string;
    }
  | {
      kind: "rows";
      headline: string;
      rows: ToolResultRow[];
      more: number;
    }
  | { kind: "text"; text: string };

const ROW_LIMIT = 8;
const HIDDEN_KEYS = new Set([
  "node_id",
  "avatar_url",
  "gravatar_id",
  "site_admin",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value;
  const texts: string[] = [];
  for (const block of value.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return value;
  const joined = texts.join("\n");
  return tryJson(joined) ?? joined;
}

function labelize(key: string): string {
  if (key === "html_url" || key === "url") return "Link";
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function scanJsonString(text: string, key: string): string | undefined {
  const marker = `"${key}"`;
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  let i = start + marker.length;
  while (i < text.length && text[i] !== ":") i += 1;
  i += 1;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  if (text[i] !== '"') return undefined;
  i += 1;
  let out = "";
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else out += next;
      i += 2;
      continue;
    }
    if (char === '"') return out;
    out += char;
    i += 1;
  }
  return out.trim() ? out : undefined;
}

function scanJsonNumber(text: string, key: string): number | undefined {
  const match = text.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+)`));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function scanAllJsonStrings(text: string, key: string): string[] {
  const values: string[] = [];
  let from = 0;
  const marker = `"${key}"`;
  while (from < text.length) {
    const start = text.indexOf(marker, from);
    if (start < 0) break;
    const slice = text.slice(start);
    const value = scanJsonString(slice, key);
    if (value) values.push(value);
    from = start + marker.length;
  }
  return values;
}

function isPull(record: Record<string, unknown>): boolean {
  const number = record.number;
  return (
    typeof record.title === "string" &&
    (typeof number === "number" || typeof number === "string") &&
    (typeof record.html_url === "string" || isRecord(record.user))
  );
}

function authorLogin(record: Record<string, unknown>): string | undefined {
  if (!isRecord(record.user)) return undefined;
  return typeof record.user.login === "string" ? record.user.login : undefined;
}

function presentPull(record: Record<string, unknown>): ToolResultPresentation {
  const fields: ToolResultField[] = [];
  if (typeof record.state === "string") {
    fields.push({ label: "State", value: record.state });
  }
  const author = authorLogin(record);
  if (author) fields.push({ label: "Author", value: author });
  if (typeof record.html_url === "string") {
    fields.push({
      label: "Link",
      value: "Open pull request",
      href: record.html_url,
    });
  }
  const body = stringField(record, "body");
  const href = typeof record.html_url === "string" ? record.html_url : "";
  const kindLabel =
    href.includes("/issues/") && !href.includes("/pull/") ? "Issue" : "PR";
  return {
    kind: "card",
    headline: `${kindLabel} #${String(record.number)} · ${String(record.title)}`,
    fields,
    prose: body,
  };
}

function diffStat(record: Record<string, unknown>): string | undefined {
  const additions = record.additions;
  const deletions = record.deletions;
  if (typeof additions !== "number" && typeof deletions !== "number") {
    return undefined;
  }
  const added = typeof additions === "number" ? additions : 0;
  const removed = typeof deletions === "number" ? deletions : 0;
  return `+${added} −${removed}`;
}

function presentFiles(items: Record<string, unknown>[]): ToolResultPresentation {
  const rows = items.slice(0, ROW_LIMIT).map((item) => ({
    primary: String(item.filename ?? item.file ?? "file"),
    secondary: typeof item.status === "string" ? item.status : undefined,
    stat: diffStat(item),
  }));
  const count = items.length;
  return {
    kind: "rows",
    headline: count === 1 ? "1 file" : `${count} files`,
    rows,
    more: Math.max(0, count - ROW_LIMIT),
  };
}

function presentArray(items: unknown[]): ToolResultPresentation | undefined {
  if (items.length === 0) {
    return { kind: "card", headline: "Empty list", fields: [] };
  }
  if (items.every((item) => isRecord(item))) {
    const records = items as Record<string, unknown>[];
    if (records.every((item) => typeof item.filename === "string")) {
      return presentFiles(records);
    }
    const rows = records.slice(0, ROW_LIMIT).map((item) => {
      const primary = ["filename", "name", "title", "path", "sha"]
        .map((key) => item[key])
        .find((value): value is string => typeof value === "string");
      return {
        primary: primary ?? "item",
        secondary: typeof item.status === "string" ? item.status : undefined,
        stat: diffStat(item),
      };
    });
    return {
      kind: "rows",
      headline: records.length === 1 ? "1 item" : `${records.length} items`,
      rows,
      more: Math.max(0, records.length - ROW_LIMIT),
    };
  }
  if (items.every((item) => typeof item === "string" || typeof item === "number")) {
    return {
      kind: "rows",
      headline: items.length === 1 ? "1 item" : `${items.length} items`,
      rows: items.slice(0, ROW_LIMIT).map((item) => ({ primary: String(item) })),
      more: Math.max(0, items.length - ROW_LIMIT),
    };
  }
  return undefined;
}

function presentObject(record: Record<string, unknown>): ToolResultPresentation {
  if (isPull(record)) return presentPull(record);
  const fields: ToolResultField[] = [];
  let prose: string | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (key === "user" && isRecord(value) && typeof value.login === "string") {
      fields.push({ label: "Author", value: value.login });
      continue;
    }
    if (typeof value === "string") {
      if (key.endsWith("_url") || key === "url") {
        if (key === "html_url" || key === "url") {
          fields.push({ label: labelize(key), value, href: value });
        }
        continue;
      }
      if (value.length > 160 || value.includes("\n")) {
        if (!prose || key === "body" || key === "content" || key === "text") {
          prose = value;
        }
        continue;
      }
      fields.push({ label: labelize(key), value });
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      fields.push({ label: labelize(key), value: String(value) });
    }
  }
  const title =
    stringField(record, "title") ??
    stringField(record, "name") ??
    stringField(record, "summary");
  return {
    kind: "card",
    headline: title ?? "Result",
    fields: fields.filter((field) => field.value !== title).slice(0, 8),
    prose,
  };
}

function presentValue(value: unknown): ToolResultPresentation | undefined {
  if (typeof value === "string") {
    const nested = tryJson(value);
    if (nested !== undefined) return presentValue(nested);
    return { kind: "text", text: value };
  }
  if (Array.isArray(value)) return presentArray(value);
  if (isRecord(value)) return presentObject(value);
  return undefined;
}

function salvage(text: string): ToolResultPresentation | undefined {
  if (
    text.startsWith("{") &&
    text.includes('"title"') &&
    text.includes('"number"')
  ) {
    const title = scanJsonString(text, "title");
    const number = scanJsonNumber(text, "number");
    if (title && number !== undefined) {
      const fields: ToolResultField[] = [];
      const state = scanJsonString(text, "state");
      const author = scanJsonString(text, "login");
      const href = scanJsonString(text, "html_url");
      if (state) fields.push({ label: "State", value: state });
      if (author) fields.push({ label: "Author", value: author });
      if (href) {
        fields.push({ label: "Link", value: "Open pull request", href });
      }
      return {
        kind: "card",
        headline: `PR #${number} · ${title}`,
        fields,
        prose: scanJsonString(text, "body"),
      };
    }
  }
  if (text.startsWith("[")) {
    const names = scanAllJsonStrings(text, "filename");
    if (names.length > 0) {
      return {
        kind: "rows",
        headline: names.length === 1 ? "1 file" : `${names.length} files`,
        rows: names.slice(0, ROW_LIMIT).map((name) => ({ primary: name })),
        more: Math.max(0, names.length - ROW_LIMIT),
      };
    }
  }
  return undefined;
}

export function presentToolResult(raw: string): ToolResultPresentation {
  const text = raw.trim();
  if (!text) return { kind: "text", text: "" };
  const parsed = tryJson(text);
  if (parsed !== undefined) {
    const view = presentValue(unwrapPayload(parsed));
    if (view) return view;
  }
  return salvage(text) ?? { kind: "text", text };
}

function compactPayload(value: string): string {
  return value.replace(/…$/, "").replace(/\s+/g, "");
}

function samePayload(left: string, right: string): boolean {
  const a = compactPayload(left);
  const b = compactPayload(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const n = Math.min(a.length, b.length, 80);
  if (n < 12) return false;
  return a.slice(0, n) === b.slice(0, n);
}

export function toolPayloadMatches(
  resultPreview: string,
  messageText: string,
): boolean {
  const candidates = [resultPreview];
  const parsed = tryJson(resultPreview.replace(/…$/, ""));
  if (parsed !== undefined) {
    const unwrapped = unwrapPayload(parsed);
    if (typeof unwrapped === "string") candidates.push(unwrapped);
  }
  const inner = scanJsonString(resultPreview, "text");
  if (inner) candidates.push(inner);
  return candidates.some((candidate) => samePayload(candidate, messageText));
}

export function toolResultSummary(raw: string): string {
  const view = presentToolResult(raw);
  const line =
    view.kind === "text"
      ? (view.text.split("\n").find((part) => part.trim()) ?? "")
      : view.headline;
  const trimmed = line.trim();
  if (!trimmed) return "";
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed;
}
