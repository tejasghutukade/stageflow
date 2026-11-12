import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
  type Server,
} from "node:http";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import { logger as rootLogger } from "../logging/logger.js";
import type { StageflowHostBootstrap } from "./bootstrap.js";
import {
  allowListenAddress,
  assertAllowedHttpAccess,
  isLoopbackRemoteAddress,
  resolveAllowedHosts,
  type AllowedHosts,
} from "./allowedHosts.js";
import { handleConsoleLogin, handleConsoleLoginMint } from "./consoleLogin.js";
import {
  authHintBody,
  enforceBearerAuth,
  loadControlTokens,
  requiredScopeFor,
  resolveClientBearerToken,
  type ControlTokens,
} from "./controlToken.js";
import {
  requestAuthFromBearer,
  runWithRequestAuth,
} from "./requestAuthContext.js";
import { advertisedHost } from "./listenHost.js";
import { handleLivez, handleReadyz } from "./healthSurfaces.js";
import { a2aStatusView } from "../a2a/errorText.js";

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

export type BoundHostPort = {
  server: Server;
  setRequestHandler: (handler: RequestListener) => void;
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
  /** Already listening. createHttpHost installs the request handler and does not bind again. */
  bound?: BoundHostPort;
};

function listenServer(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Bind the host port before startup mutates run data. Connections are dropped
 * until {@link createHttpHost} installs the real handler. A failure is the
 * Node listen error (EADDRINUSE when another host already owns the port).
 */
export async function bindHostPort(host: string, port: number): Promise<BoundHostPort> {
  let requestHandler: RequestListener = (req, res) => {
    req.socket?.on("error", () => undefined);
    res.destroy();
  };
  const server = createServer((req, res) => {
    requestHandler(req, res);
  });
  try {
    await listenServer(server, host, port);
  } catch (err) {
    server.close(() => undefined);
    throw err;
  }
  return {
    server,
    setRequestHandler(next) {
      requestHandler = next;
    },
  };
}

export type HttpHostEnvelope = {
  server: Server;
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  manager?: RunManager;
  store?: RunStore;
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

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${advertisedHost(host)}:${port}`);
    const pathname = url.pathname;

    if (
      (pathname === "/livez" || pathname === "/readyz" || pathname === "/api/auth-hint") &&
      (method === "GET" || method === "HEAD")
    ) {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (pathname === "/api/auth-hint") {
        json(res, 200, authHintBody(req.socket?.remoteAddress));
        return;
      }
      if (pathname === "/livez") {
        handleLivez(req, res);
        return;
      }
      await handleReadyz(req, res, boot);
      return;
    }

    if (pathname === "/api/a2a/status" && method === "GET") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (boot.serveBlocked !== undefined) {
        json(res, 503, {
          error: boot.serveBlocked.reason,
          code: boot.serveBlocked.code,
        });
        return;
      }
      const a2aAuth = enforceBearerAuth(controlTokens, req, res, "read");
      if (!a2aAuth.ok) return;
      json(res, 200, boot.a2a ? a2aStatusView(boot.a2a.status) : { state: "disabled" });
      return;
    }
    if (boot.serveBlocked !== undefined) {
      const a2aOwned =
        pathname === "/a2a" ||
        pathname === "/.well-known/agent-card.json" ||
        pathname.startsWith("/a2a/contracts/") ||
        pathname.startsWith("/a2a/artifacts/");
      if (a2aOwned) {
        if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
        json(res, 503, {
          error: boot.serveBlocked.reason,
          code: boot.serveBlocked.code,
        });
        return;
      }
    }
    if (await boot.a2a?.handle(req, res, pathname)) return;

    if (pathname === "/mcp") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (boot.serveBlocked !== undefined) {
        json(res, 503, {
          error: boot.serveBlocked.reason,
          code: boot.serveBlocked.code,
        });
        return;
      }
      const mcpAuth = enforceBearerAuth(controlTokens, req, res, "drive");
      if (!mcpAuth.ok) return;
      res.setTimeout(0);
      try {
        await runWithRequestAuth(
          requestAuthFromBearer(mcpAuth.auth, "mcp"),
          () => boot.mcpHandler.handle(req, res),
        );
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

    if (pathname === "/api/console-login" && method === "POST") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      await handleConsoleLogin(req, res, () => resolveClientBearerToken("POST"));
      return;
    }
    if (pathname === "/api/console-login/mint" && method === "POST") {
      if (!assertAllowedHttpAccess(allowedHosts, req, res)) return;
      if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
        json(res, 403, { error: "loopback only" });
        return;
      }
      const mintAuth = enforceBearerAuth(controlTokens, req, res, "drive");
      if (!mintAuth.ok) return;
      handleConsoleLoginMint(req, res);
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
  };

  const server = options.bound?.server ?? createServer(handleRequest);
  if (options.bound) {
    options.bound.setRequestHandler(handleRequest);
  }

  // requestTimeout bounds receiving the request body (408); idle socket timeout
  // stays 0 so MCP SSE can outlive requestTimeout.
  server.requestTimeout = requestTimeoutMs;
  server.maxConnections = maxConnections;

  server.on("close", () => {
    boot.stopGcInterval();
    boot.stopScheduleSource();
    boot.stopGithubPollSource();
    boot.stopEmailSource();
    void boot.mcpHandler.close();
  });

  if (options.bound === undefined) {
    await listenServer(server, host, port);
  }

  server.on("error", (err) => {
    log.error("host.server_error", err instanceof Error ? err.message : String(err));
  });

  const address = server.address();
  const boundPort =
    address && typeof address !== "string" ? address.port : port;
  allowListenAddress(allowedHosts, host, boundPort);
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
