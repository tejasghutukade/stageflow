import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type McpToolInfo = {
  /** The name to put in an agent's `tools.mcp.<server>` list. */
  name: string;
  description?: string;
};

export type McpToolList = { tools: McpToolInfo[]; cachedAt: number };

/**
 * The name an agent grants for one MCP tool. The adapter exposes `<server>_<tool>` to Pi (dots in the
 * tool name become underscores) and the runtime strips `<server>_` again, so the grant is the
 * sanitised tool name without that prefix.
 */
export function grantNameForMcpTool(server: string, tool: string): string {
  const sanitized = tool.replace(/\./g, "_");
  return sanitized.startsWith(`${server}_`) && sanitized.length > server.length + 1
    ? sanitized.slice(server.length + 1)
    : sanitized;
}

/**
 * Tools the adapter saw the last time it connected to `server` (it writes them to the Pi agent dir's
 * `mcp-cache.json`). Undefined when it has never connected.
 */
export function listCachedMcpTools(
  server: string,
  agentDir: string = getAgentDir(),
): McpToolList | undefined {
  const file = path.join(agentDir, "mcp-cache.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      servers?: Record<string, { tools?: Array<{ name?: unknown; description?: unknown }>; cachedAt?: unknown }>;
    };
    const entry = parsed.servers?.[server];
    if (!entry || !Array.isArray(entry.tools)) return undefined;
    const tools: McpToolInfo[] = [];
    for (const tool of entry.tools) {
      if (typeof tool.name !== "string") continue;
      tools.push({
        name: grantNameForMcpTool(server, tool.name),
        ...(typeof tool.description === "string" && tool.description ? { description: tool.description } : {}),
      });
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, cachedAt: typeof entry.cachedAt === "number" ? entry.cachedAt : 0 };
  } catch {
    return undefined;
  }
}
