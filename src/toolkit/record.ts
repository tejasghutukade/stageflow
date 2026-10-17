import type { ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { McpToolDeps } from "../mcp/deps.js";
import { registerMcpTools } from "../mcp/tools.js";

/** An MCP tool as registered: its name, text, input schema and handler. */
export type RecordedTool = {
  name: string;
  description: string;
  inputSchema: ZodType | undefined;
  readOnlyHint: boolean | undefined;
  handler: (args: Record<string, unknown>, ctx: unknown) => unknown;
};

/**
 * Run the real MCP registration against a recorder instead of a server, so the
 * toolkit describes exactly the tools the MCP surface exposes, with no second list to drift.
 */
export function recordMcpTools(deps: McpToolDeps): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const recorder = {
    registerTool(name: string, config: { description?: string; inputSchema?: ZodType; annotations?: { readOnlyHint?: boolean } }, handler: RecordedTool["handler"]) {
      tools.push({ name, description: config.description ?? "", inputSchema: config.inputSchema, readOnlyHint: config.annotations?.readOnlyHint, handler });
    },
    registerResource() {},
    registerPrompt() {},
  };
  registerMcpTools(recorder as unknown as McpServer, deps);
  return tools;
}
