import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { probeProjectMcpServer } from "../agent/piIsolatedMcpProbe.js";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export function registerProjectMcpTools(
  server: McpServer,
  deps: McpToolDeps,
): void {
  const { cwd, projectRoot } = deps;
  const root = projectRoot ?? cwd;

  server.registerTool(
    "list_project_mcp",
    {
      description:
        "List git-root .mcp.json servers as names and transport only (same as GET /api/project-mcp). Inspect is not attach; it does not interpolate, spawn, or change stage MCP.",
      inputSchema: z.object({}),
    },
    async () => textResult(await listProjectMcpCatalog(root)),
  );

  server.registerTool(
    "probe_project_mcp",
    {
      description:
        "Probe one named git-root .mcp.json server with connect-and-exit (same as POST /api/project-mcp/:name/probe). Inspect is not attach; YAML mcp: still allowlists what a stage receives.",
      inputSchema: z.object({
        name: z.string(),
      }),
    },
    async ({ name }, ctx) => {
      const result = await probeProjectMcpServer({
        projectRoot: root,
        name,
        signal: ctx.mcpReq.signal,
      });
      return textResult(result);
    },
  );
}
