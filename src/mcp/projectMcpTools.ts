import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { probeProjectMcpServer } from "../agent/piIsolatedMcpProbe.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export function registerProjectMcpTools(
  server: McpServer,
  deps: McpToolDeps,
): void {
  const { cwd, projectRoot } = deps;
  const root = projectRoot ?? cwd;

  server.registerTool(
    "probe_project_mcp",
    {
      description:
        "Probe one named git-root .mcp.json server with connect-and-exit. Inspect is not attach; YAML mcp: still allowlists what a stage receives.",
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
