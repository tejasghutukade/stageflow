export const DEFAULT_MCP_URL = "http://127.0.0.1:3847/mcp";

export type LocationLike = {
  hostname: string;
  port: string;
  protocol: string;
};

export function mcpEndpointUrl(
  location: LocationLike,
  options: { viteDev?: boolean } = {},
): string {
  if (options.viteDev) return DEFAULT_MCP_URL;
  const loopback =
    location.hostname === "127.0.0.1" ||
    location.hostname === "localhost" ||
    location.hostname === "[::1]";
  if (!loopback) return DEFAULT_MCP_URL;
  const host =
    location.hostname === "localhost" || location.hostname === "[::1]"
      ? "127.0.0.1"
      : location.hostname;
  const origin = `${location.protocol}//${host}${location.port ? `:${location.port}` : ""}`;
  return `${origin}/mcp`;
}

export function cursorMcpConfigJson(url: string): string {
  return `${JSON.stringify(
    { mcpServers: { stageflow: { url } } },
    null,
    2,
  )}\n`;
}
