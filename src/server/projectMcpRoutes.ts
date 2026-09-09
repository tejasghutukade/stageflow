import type { IncomingMessage, ServerResponse } from "node:http";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";

export type ProjectMcpRoutesCtx = {
  projectRoot: string;
  json: (res: ServerResponse, status: number, body: unknown) => void;
};

export async function handleProjectMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProjectMcpRoutesCtx,
): Promise<boolean> {
  const { projectRoot, json } = ctx;
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const pathname = new URL(rawUrl, "http://localhost").pathname;

  if (method === "GET" && pathname === "/api/project-mcp") {
    json(res, 200, await listProjectMcpCatalog(projectRoot));
    return true;
  }

  return false;
}
