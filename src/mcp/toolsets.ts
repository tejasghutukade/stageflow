import {
  isToolsetId,
  TOOL_META,
  TOOLSETS,
  toolsInToolset,
  type ToolsetId,
} from "../toolkit/meta.js";

export type ResolveToolsetsResult = { ok: true; tools: string[] } | { ok: false; unknown: string[] };

export type ResolveLoadedToolsetIdsResult =
  | { ok: true; ids: ToolsetId[] }
  | { ok: false; unknown: string[] };

const ALL_TOOL_NAMES = Object.keys(TOOL_META).sort();

function parseTokens(raw: string | readonly string[] | undefined): string[] {
  const chunks =
    raw === undefined || raw === null
      ? []
      : typeof raw === "string"
        ? [raw]
        : [...raw];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    for (const piece of chunk.split(",")) {
      const token = piece.trim().toLowerCase();
      if (token) tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

export function toolsetIds(): ToolsetId[] {
  return TOOLSETS.map((entry) => entry.id);
}

export function toolsetsQueryFromUrl(url: string | undefined): string | readonly string[] | undefined {
  if (!url) return undefined;
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return undefined;
  const all = new URLSearchParams(url.slice(qIndex + 1)).getAll("toolsets");
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return all;
}

export function unknownToolsetsMessage(unknown: string[]): string {
  const valid = [...toolsetIds(), "all"].sort().join(", ");
  return `Unknown toolset(s): ${unknown.join(", ")}. Valid toolsets: ${valid}`;
}

export function resolveLoadedToolsetIds(
  raw: string | readonly string[] | undefined,
): ResolveLoadedToolsetIdsResult {
  const tokens = parseTokens(raw);
  if (tokens.length === 0) {
    return { ok: true, ids: ["core"] };
  }
  if (tokens.includes("all")) {
    return { ok: true, ids: toolsetIds() };
  }
  const unknown = tokens.filter((token) => !isToolsetId(token));
  if (unknown.length > 0) {
    return { ok: false, unknown: [...new Set(unknown)].sort() };
  }
  const ids = new Set<ToolsetId>(["core"]);
  for (const token of tokens) {
    if (isToolsetId(token)) ids.add(token);
  }
  return { ok: true, ids: [...ids].sort() };
}

export function resolveToolsets(raw: string | readonly string[] | undefined): ResolveToolsetsResult {
  const tokens = parseTokens(raw);
  if (tokens.length === 0) {
    return { ok: true, tools: toolsInToolset("core") };
  }
  if (tokens.includes("all")) {
    return { ok: true, tools: [...ALL_TOOL_NAMES] };
  }
  const unknown = tokens.filter((token) => !isToolsetId(token));
  if (unknown.length > 0) {
    return { ok: false, unknown: [...new Set(unknown)].sort() };
  }
  const names = new Set<string>(toolsInToolset("core"));
  for (const id of tokens) {
    if (!isToolsetId(id) || id === "core") continue;
    for (const tool of toolsInToolset(id)) names.add(tool);
  }
  return { ok: true, tools: [...names].sort() };
}