import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import { logger as rootLogger } from "../logging/logger.js";
import type { StageflowHostBootstrap } from "./bootstrap.js";
import {
  assertAllowedHttpAccess,
  resolveAllowedHosts,
  type AllowedHosts,
} from "./allowedHosts.js";
import {
  enforceBearerAuth,
  loadControlTokens,
  requiredScopeFor,
  type ControlTokens,
} from "./controlToken.js";
import { advertisedHost } from "./listenHost.js";

export const DEFAULT_PORT = 3847;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_CONNECTIONS = 256;

const log = rootLogger.child({ component: "http" });

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export type HttpHostRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
  json: typeof json;
  boot: StageflowHostBootstrap;
};

export type CreateHttpHostOptions = {
  boot: StageflowHostBootstrap;
  host: string;
  port: number;
  routes: (ctx: HttpHostRouteContext) => Promise<boolean | void>;
  allowedHosts?: AllowedHosts;
  controlTokens?: ControlTokens;
  requestTimeoutMs?: number;
  maxConnections?: number;
};

export type HttpHostEnvelope = {
  server: Server;
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  manager: RunManager;
  store: RunStore;
  runChangeBus: RunChangeBus;
  mcpStateless: boolean;
};

function resolveRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STAGEFLOW_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return n;
}

function resolveMaxConnections(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STAGEFLOW_MAX_CONNECTIONS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONNECTIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONNECTIONS;
  return Math.floor(n);
}

export async function createHttpHost(
  options: CreateHttpHostOptions,
): Promise<HttpHostEnvelope> {
  const { boot, host, port, routes } = options;
  const allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = options.controlTokens ?? loadControlTokens();
  const requestTimeoutMs =
    options.requestTimeoutMs ?? resolveRequestTimeoutMs();
  const maxConnections = options.maxConnections ?? resolveMaxConnections();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${advertisedHost(host)}:${port}`);
    const pathname = url.pathname;

    if (pathname === "/api/a2a/status" && method === "GET") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (!enforceBearerAuth(controlTokens, req, res, "read")) return;
      json(res, 200, boot.a2a?.status ?? { state: "disabled" });
      return;
    }
    if (await boot.a2a?.handle(req, res, pathname)) return;

    if (pathname === "/mcp") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (!enforceBearerAuth(controlTokens, req, res, "drive")) return;
      res.setTimeout(0);
      try {
        await boot.mcpHandler.handle(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("mcp.handler_error", message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(message);
        }
      }
      return;
    }

    const handled = await routes({
      req,
      res,
      url,
      pathname,
      method,
      json,
      boot,
    });
    if (handled) return;
    json(res, 404, { error: "Not found" });
  });

  // requestTimeout bounds receiving the request body (408); idle socket timeout
  // stays 0 so MCP SSE can outlive requestTimeout.
  server.requestTimeout = requestTimeoutMs;
  server.maxConnections = maxConnections;

  server.on("close", () => {
    boot.stopGcInterval();
    void boot.mcpHandler.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  server.on("error", (err) => {
    log.error("host.server_error", err instanceof Error ? err.message : String(err));
  });

  const address = server.address();
  const boundPort =
    address && typeof address !== "string" ? address.port : port;
  const publicHost = advertisedHost(host);
  const url = `http://${publicHost}:${boundPort}`;
  const mcpUrl = `${url}/mcp`;
  log.info("host.listening", `listening on ${url}`, {
    host,
    port: boundPort,
    mcp_url: mcpUrl,
  });
  return {
    server,
    port: boundPort,
    host,
    url,
    mcpUrl,
    manager: boot.manager,
    store: boot.store,
    runChangeBus: boot.runChangeBus,
    mcpStateless: boot.mcpStateless,
  };
}

export { requiredScopeFor };
