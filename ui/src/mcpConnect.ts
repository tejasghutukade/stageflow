export const DEFAULT_MCP_URL = "http://127.0.0.1:3847/mcp";

export type LocationLike = {
  hostname: string;
  port: string;
  protocol: string;
};

/** Non-core toolsets in catalog order (must match `TOOLSETS` in the Host). */
export const OPTIONAL_MCP_TOOLSET_IDS = [
  "runs",
  "catalog",
  "agents",
  "evals",
  "functions",
  "triggers",
  "connections",
  "memories",
] as const;

export const MCP_BARE_URL_NOTES =
  "A URL with no toolsets query loads only the core tools. Reconnect the client after changing the URL; the tool list is fixed for the session.";

export function mcpToolsetsQuery(selected: readonly string[]): string {
  const pick = new Set(
    selected.map((id) => id.trim().toLowerCase()).filter((id) => id && id !== "core"),
  );
  if (pick.size === 0) return "";
  if (pick.size === OPTIONAL_MCP_TOOLSET_IDS.length && OPTIONAL_MCP_TOOLSET_IDS.every((id) => pick.has(id))) {
    return "?toolsets=all";
  }
  return `?toolsets=${[...pick].sort().join(",")}`;
}

export function mcpEndpointUrl(
  location: LocationLike,
  options: { viteDev?: boolean; toolsets?: readonly string[]; publicOrigin?: string | null } = {},
): string {
  if (options.viteDev) {
    const base = DEFAULT_MCP_URL;
    const query = options.toolsets ? mcpToolsetsQuery(options.toolsets) : "";
    return `${base}${query}`;
  }
  if (options.publicOrigin) {
    const query = options.toolsets ? mcpToolsetsQuery(options.toolsets) : "";
    return `${options.publicOrigin.replace(/\/+$/, "")}/mcp${query}`;
  }
  let host = location.hostname;
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    host = "127.0.0.1";
  } else if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }
  const origin = `${location.protocol}//${host}${location.port ? `:${location.port}` : ""}`;
  const query = options.toolsets ? mcpToolsetsQuery(options.toolsets) : "";
  return `${origin}/mcp${query}`;
}

export const MCP_API_KEY_PLACEHOLDER = "Bearer YOUR_DRIVE_API_KEY";

export function cursorMcpConfigJson(url: string, options: { apiKeyHeader?: boolean } = {}): string {
  const server = options.apiKeyHeader
    ? { url, headers: { Authorization: MCP_API_KEY_PLACEHOLDER } }
    : { url };
  return `${JSON.stringify({ mcpServers: { stageflow: server } }, null, 2)}\n`;
}