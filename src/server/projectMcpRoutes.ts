import type { IncomingMessage, ServerResponse } from "node:http";
import { probeProjectMcpServer } from "../agent/piIsolatedMcpProbe.js";
import { listProjectMcpCatalog } from "../config/resolveStageMcpServers.js";

export type ProjectMcpRoutesCtx = {
  projectRoot: string;
  json: (res: ServerResponse, status: number, body: unknown) => void;
};

function requestAbortSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (req.aborted || req.destroyed) {
    abort();
    return controller.signal;
  }
  req.once("aborted", abort);
  req.once("close", abort);
  return controller.signal;
}

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

  const probeMatch = pathname.match(/^\/api\/project-mcp\/([^/]+)\/probe$/);
  if (method === "POST" && probeMatch) {
    const name = decodeURIComponent(probeMatch[1] ?? "");
    const result = await probeProjectMcpServer({
      projectRoot,
      name,
      signal: requestAbortSignal(req),
    });
    json(res, 200, result);
    return true;
  }

  return false;
}
