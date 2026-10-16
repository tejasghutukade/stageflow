import type { IncomingMessage, ServerResponse } from "node:http";
import { probeProjectMcpServer } from "../agent/piIsolatedMcpProbe.js";
import {
  deleteMcpSecret,
  listMcpSecretNames,
  parsePastedMcpJson,
  readHostMcpServers,
  removeHostMcpServer,
  requiredVars,
  saveHostMcpServer,
  setMcpSecret,
  type HostMcpError,
} from "../config/mcpHostCatalog.js";
import { listCachedMcpTools } from "../config/mcpToolCache.js";
import {
  completeMcpOAuth,
  mcpOAuthStatus,
  McpOAuthError,
  removeMcpOAuth,
  startMcpOAuth,
} from "../config/mcpOAuth.js";
import {
  listProjectMcpCatalog,
  loadMcpCatalog,
  StageMcpError,
} from "../config/resolveStageMcpServers.js";

export type ProjectMcpRoutesCtx = {
  projectRoot: string;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
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
  const { projectRoot, json, readJsonBody } = ctx;

  const hostFailure = (err: unknown): boolean => {
    const code = (err as Partial<HostMcpError> | undefined)?.code;
    if (code === "invalid_server" || code === "invalid_secret" || code === "reserved_name") {
      json(res, 400, { error: (err as Error).message, code });
      return true;
    }
    return false;
  };
  const bodyObject = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const body = await readJsonBody(req);
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    json(res, 400, { error: "Body must be a JSON object", code: "invalid_body" });
    return undefined;
  };
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const pathname = new URL(rawUrl, "http://localhost").pathname;

  if (method === "GET" && pathname === "/api/project-mcp") {
    json(res, 200, await listProjectMcpCatalog(projectRoot));
    return true;
  }

  if (method === "POST" && pathname === "/api/project-mcp/import") {
    const body = await bodyObject();
    if (!body) return true;
    try {
      const entries = parsePastedMcpJson(body.json ?? body);
      const added: string[] = [];
      const secretsStored: string[] = [];
      const errors: Array<{ name: string; error: string }> = [];
      for (const [name, entry] of Object.entries(entries)) {
        try {
          const saved = saveHostMcpServer(name, entry);
          added.push(name);
          secretsStored.push(...saved.secretsStored);
        } catch (err) {
          if ((err as Partial<HostMcpError>).code === undefined) throw err;
          errors.push({ name, error: (err as Error).message });
        }
      }
      json(res, 200, { added, secretsStored, errors });
    } catch (err) {
      if (!hostFailure(err)) throw err;
    }
    return true;
  }

  if (pathname === "/api/mcp-secrets" && method === "GET") {
    const servers = (await loadMcpCatalog(projectRoot, { host: true }).catch(() => undefined))?.servers ?? {};
    const usedBy = new Map<string, string[]>();
    for (const [server, entry] of Object.entries(servers)) {
      for (const v of requiredVars(entry)) usedBy.set(v, [...(usedBy.get(v) ?? []), server]);
    }
    const stored = new Set(listMcpSecretNames());
    json(res, 200, {
      secrets: [...stored].map((name) => ({ name, usedBy: usedBy.get(name) ?? [] })),
      // Placeholders servers reference; `set` = a stored secret or a Host env var fills it.
      needed: [...usedBy].map(([name, by]) => ({
        name,
        usedBy: by,
        set: stored.has(name) || (process.env[name] ?? "") !== "",
      })),
    });
    return true;
  }

  const secretMatch = pathname.match(/^\/api\/mcp-secrets\/([^/]+)$/);
  if (secretMatch && (method === "PUT" || method === "DELETE")) {
    const name = decodeURIComponent(secretMatch[1] ?? "");
    if (method === "DELETE") {
      if (!deleteMcpSecret(name)) json(res, 404, { error: "Secret not found", code: "not_found" });
      else json(res, 200, { name });
      return true;
    }
    const body = await bodyObject();
    if (!body) return true;
    if (typeof body.value !== "string") {
      json(res, 400, { error: "value must be a string", code: "invalid_secret" });
      return true;
    }
    try {
      setMcpSecret(name, body.value);
      json(res, 200, { name });
    } catch (err) {
      if (!hostFailure(err)) throw err;
    }
    return true;
  }

  const toolsMatch = pathname.match(/^\/api\/project-mcp\/([^/]+)\/tools$/);
  if (toolsMatch && method === "GET") {
    const name = decodeURIComponent(toolsMatch[1] ?? "");
    const cached = listCachedMcpTools(name);
    json(res, 200, cached ? { name, tools: cached.tools, cachedAt: cached.cachedAt } : { name, tools: null });
    return true;
  }

  const oauthMatch = pathname.match(/^\/api\/project-mcp\/([^/]+)\/oauth(\/start|\/complete)?$/);
  if (oauthMatch) {
    const name = decodeURIComponent(oauthMatch[1] ?? "");
    const action = oauthMatch[2];
    try {
      if (method === "GET" && !action) {
        json(res, 200, { name, status: await mcpOAuthStatus(name) });
        return true;
      }
      if (method === "DELETE" && !action) {
        await removeMcpOAuth(name);
        json(res, 200, { name, status: "not_authenticated" });
        return true;
      }
      if (method === "POST" && action === "/start") {
        json(res, 200, { name, ...(await startMcpOAuth(projectRoot, name)) });
        return true;
      }
      if (method === "POST" && action === "/complete") {
        const body = await bodyObject();
        if (!body) return true;
        if (typeof body.input !== "string" || body.input.trim() === "") {
          json(res, 400, { error: "Paste the full address from the browser", code: "invalid_body" });
          return true;
        }
        json(res, 200, { name, status: await completeMcpOAuth(name, body.input) });
        return true;
      }
    } catch (err) {
      if (err instanceof McpOAuthError) {
        json(res, err.code === "not_found" ? 404 : err.code === "flow_failed" ? 400 : err.code === "not_http" ? 400 : 500, {
          error: err.message,
          code: err.code,
        });
        return true;
      }
      if (err instanceof StageMcpError) {
        json(res, 400, { error: err.message, code: err.code });
        return true;
      }
      throw err;
    }
  }

  const serverMatch = pathname.match(/^\/api\/project-mcp\/([^/]+)$/);
  if (serverMatch && method === "GET") {
    const name = decodeURIComponent(serverMatch[1] ?? "");
    const config = readHostMcpServers()[name];
    if (config) json(res, 200, { name, origin: "console", config });
    else json(res, 404, { error: "Only servers saved from the console can be read back", code: "not_found" });
    return true;
  }
  if (serverMatch && method === "PUT") {
    const name = decodeURIComponent(serverMatch[1] ?? "");
    const body = await bodyObject();
    if (!body) return true;
    try {
      json(res, 200, saveHostMcpServer(name, body.config));
    } catch (err) {
      if (!hostFailure(err)) throw err;
    }
    return true;
  }
  if (serverMatch && method === "DELETE") {
    const name = decodeURIComponent(serverMatch[1] ?? "");
    if (removeHostMcpServer(name)) {
      json(res, 200, { name });
      return true;
    }
    const inProject = (await listProjectMcpCatalog(projectRoot)).servers.some((e) => e.name === name);
    json(
      res,
      inProject ? 409 : 404,
      inProject
        ? { error: "Defined in the project .mcp.json; edit that file to remove it", code: "project_defined" }
        : { error: "Server not found", code: "not_found" },
    );
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
