import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { registerMcpTools, type McpToolDeps } from "./tools.js";

export type { McpToolDeps };

export function createStageflowMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({
    name: "stageflow",
    version: "0.2.0",
  });
  registerMcpTools(server, deps);
  return server;
}

/** Stateless Streamable HTTP: new server + transport per request. */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpToolDeps,
): Promise<void> {
  const server = createStageflowMcpServer(deps);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
