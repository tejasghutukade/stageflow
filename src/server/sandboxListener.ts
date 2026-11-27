import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { logger as rootLogger } from "../logging/logger.js";
import {
  SANDBOX_KEEPALIVE_MS,
  SANDBOX_MAX_CONNECTIONS,
  SANDBOX_MAX_HEADER_BYTES,
  SANDBOX_PORT_MAX,
  SANDBOX_PORT_MIN,
  SANDBOX_PORT_SCAN,
  SHELL_PERMISSIONS_POLICY,
  consoleHostIsIpv6,
  loopbackListen,
  advertisedSandboxOrigins,
  sandboxPublicOriginProblem,
  parseSandboxOrigin,
  readSandboxPort,
  sandboxDisabledByEnv,
  sandboxHostname,
  sandboxOriginPair,
  shellDocumentHeaders,
  type SandboxDisableReason,
} from "./sandboxPolicy.js";
import { readHtmlLibraryFile } from "../artifacts/library/htmlLibraryFiles.js";
import { artifactEvalLibsAllowed } from "../artifacts/library/htmlLibraries.js";
import { SHELL_HTML, shellScript } from "./sandboxShell.js";

const log = rootLogger.child({ component: "sandbox" });

export type SandboxListener = {
  origin: string | null;
  origins: string[];
  port: number;
  addresses: string[];
  reason: SandboxDisableReason;
  stopAccepting: () => void;
  close: () => Promise<void>;
};

export type SandboxBind = (
  host: string,
  port: number,
  ipv6Only: boolean,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) => Promise<Server>;

export type StartSandboxListenerOptions = {
  consoleOrigins: readonly string[];
  hostPort: number;
  listenHost: string;
  env?: NodeJS.ProcessEnv;
  bind?: SandboxBind;
};

const ROUTES = new Set(["/shell.html", "/shell.js", "/livez"]);

export async function startSandboxListener(options: StartSandboxListenerOptions): Promise<SandboxListener> {
  const env = options.env ?? process.env;
  if (sandboxDisabledByEnv(env)) return idle("disabled");
  const pinned = readSandboxPort(env);
  if (pinned === "invalid") {
    log.warn("sandbox.invalid_port", "STAGEFLOW_SANDBOX_PORT is not an integer from 1024 to 65535; sandbox listener disabled", {});
    return idle("invalid-port");
  }
  if (consoleHostIsIpv6(options.listenHost)) {
    log.warn("sandbox.ipv6_console_unsupported", "sandbox listener stays off when the console hostname is an IPv6 literal; Chrome rejects that form in frame-ancestors", {});
    return idle("ipv6-console");
  }
  const remote = !loopbackListen(options.listenHost) || env.STAGEFLOW_IN_DOCKER === "1";
  if (remote && pinned === undefined) {
    log.warn("sandbox.remote_bind", "sandbox listener stays off for a container or non-loopback bind unless STAGEFLOW_SANDBOX_PORT is set", {});
    return idle("remote-bind");
  }
  const choice = sandboxHostname(options.listenHost);
  const publishedInContainer = remote && pinned !== undefined;
  const v4Host = publishedInContainer ? "0.0.0.0" : "127.0.0.1";
  const bindV6 = publishedInContainer ? false : choice.bindV6;
  const script = shellScript(options.consoleOrigins, { allowEval: artifactEvalLibsAllowed(env) });
  const headers = shellDocumentHeaders(options.consoleOrigins);
  const handler = (req: IncomingMessage, res: ServerResponse) => handle(req, res, script, headers);
  const bindSocket = options.bind ?? bind;
  if (pinned !== undefined) {
    const bound = await bindCandidate(pinned, bindV6, handler, bindSocket, v4Host);
    if (bound.status === "failed") return listenFailed(bound.code);
    if (bound.status === "busy") {
      log.warn("sandbox.pinned_taken", "STAGEFLOW_SANDBOX_PORT is in use; sandbox listener disabled", { port: pinned });
      return idle("pinned-taken");
    }
    return listening(bound.servers, choice.hostname, pinned, env);
  }
  const start = options.hostPort + 1;
  for (let offset = 0; offset < SANDBOX_PORT_SCAN; offset += 1) {
    const port = start + offset;
    if (port < SANDBOX_PORT_MIN || port > SANDBOX_PORT_MAX) continue;
    const bound = await bindCandidate(port, bindV6, handler, bindSocket, v4Host);
    if (bound.status === "failed") return listenFailed(bound.code);
    if (bound.status === "ready") return listening(bound.servers, choice.hostname, port, env);
  }
  log.warn("sandbox.no_port", "no free loopback port for the sandbox listener; live HTML falls back to the scriptless preview", {
    from: start,
    count: SANDBOX_PORT_SCAN,
  });
  return idle("no-port");
}

type BindCandidate = { status: "ready"; servers: Server[] } | { status: "busy" } | { status: "failed"; code: string };

function listening(servers: Server[], hostname: string, port: number, env: NodeJS.ProcessEnv): SandboxListener {
  const addresses = servers.map((server) => {
    const address = server.address();
    return address && typeof address !== "string" ? address.address : "";
  });
  const origin = parseSandboxOrigin(`http://${hostname}:${port}`);
  const origins = advertisedSandboxOrigins(sandboxOriginPair(port), env);
  const publicProblem = sandboxPublicOriginProblem(env);
  if (publicProblem) log.warn("sandbox.public_origin_ignored", `${publicProblem}; HTML cards and live HTML use the loopback sandbox only`, {});
  log.info("sandbox.listening", "sandbox listener started", { origin, port, addresses });
  let acceptStopped = false;
  let closed: Promise<void> | undefined;
  const stopAccepting = () => {
    if (acceptStopped) return;
    acceptStopped = true;
    for (const server of servers) {
      try {
        server.closeIdleConnections();
      } catch {
        // Node versions without the method still stop accepting below.
      }
      try {
        server.close(() => undefined);
      } catch {
        // already closing
      }
    }
  };
  return {
    origin,
    origins,
    port,
    addresses,
    reason: "listening",
    stopAccepting,
    close: () => {
      stopAccepting();
      if (!closed) closed = closeServers(servers);
      return closed;
    },
  };
}

function idle(reason: SandboxDisableReason): SandboxListener {
  return {
    origin: null,
    origins: [],
    port: 0,
    addresses: [],
    reason,
    stopAccepting: () => undefined,
    close: async () => undefined,
  };
}

function listenFailed(code: string): SandboxListener {
  log.warn("sandbox.listen_failed", "sandbox listener failed to bind and stays off", { code });
  return idle("listen-failed");
}

async function bindCandidate(
  port: number,
  bindV6: boolean,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  bindSocket: SandboxBind,
  v4Host = "127.0.0.1",
): Promise<BindCandidate> {
  let v4: Server;
  try {
    v4 = await bindSocket(v4Host, port, false, handler);
  } catch (err) {
    if (errorCode(err) === "EADDRINUSE") return { status: "busy" };
    return { status: "failed", code: errorCode(err) ?? "unknown" };
  }
  if (!bindV6) return { status: "ready", servers: [v4] };
  try {
    const v6 = await bindSocket("::1", port, true, handler);
    return { status: "ready", servers: [v4, v6] };
  } catch (err) {
    const code = errorCode(err);
    if (code === "EADDRINUSE") {
      await closeServers([v4]);
      return { status: "busy" };
    }
    if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL" || code === "EINVAL") {
      log.warn("sandbox.ipv6_unavailable", "sandbox listener did not bind ::1; localhost may not reach it if the resolver prefers IPv6", { port });
      return { status: "ready", servers: [v4] };
    }
    await closeServers([v4]);
    return { status: "failed", code: code ?? "unknown" };
  }
}

function bind(
  host: string,
  port: number,
  ipv6Only: boolean,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server> {
  const server = createServer(
    {
      maxHeaderSize: SANDBOX_MAX_HEADER_BYTES,
      requestTimeout: 5_000,
      headersTimeout: 2_000,
      keepAliveTimeout: SANDBOX_KEEPALIVE_MS,
      insecureHTTPParser: false,
    },
    handler,
  );
  server.maxConnections = SANDBOX_MAX_CONNECTIONS;
  server.keepAliveTimeout = SANDBOX_KEEPALIVE_MS;
  server.headersTimeout = 2_000;
  server.requestTimeout = 5_000;
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.close(() => undefined);
      reject(err);
    };
    server.once("error", onError);
    server.listen({ port, host, ipv6Only }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function closeServers(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    try {
      server.closeAllConnections();
    } catch {
      // Node versions without the method still close below.
    }
    server.close(() => resolve());
  })));
}

export function attachSandboxShutdown(server: Server, sandbox: SandboxListener): void {
  const idle = server.closeIdleConnections.bind(server);
  server.closeIdleConnections = () => {
    sandbox.stopAccepting();
    idle();
  };
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    sandbox.stopAccepting();
    return close(callback);
  }) as typeof server.close;
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  script: string,
  documentHeaders: Record<string, string>,
): void {
  req.resume();
  const method = req.method ?? "GET";
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    send(req, res, 404, "text/plain; charset=utf-8", "not found\n", commonHeaders());
    return;
  }
  const library = matchSandboxLibraryPath(pathname);
  if (library) {
    if (method !== "GET" && method !== "HEAD") {
      send(req, res, 405, "text/plain; charset=utf-8", "method not allowed\n", {
        ...commonHeaders(),
        Allow: "GET, HEAD",
      });
      return;
    }
    const file = readHtmlLibraryFile(library.name, library.version, library.file);
    if (!file) {
      send(req, res, 404, "text/plain; charset=utf-8", "not found\n", commonHeaders());
      return;
    }
    send(req, res, 200, file.contentType, file.body, libraryHeaders());
    return;
  }
  if (!ROUTES.has(pathname)) {
    send(req, res, 404, "text/plain; charset=utf-8", "not found\n", commonHeaders());
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    send(req, res, 405, "text/plain; charset=utf-8", "method not allowed\n", {
      ...commonHeaders(),
      Allow: "GET, HEAD",
    });
    return;
  }
  if (pathname === "/livez") {
    send(req, res, 200, "text/plain; charset=utf-8", "ok\n", commonHeaders());
    return;
  }
  if (pathname === "/shell.js") {
    send(req, res, 200, "text/javascript; charset=utf-8", script, {
      ...commonHeaders(),
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'",
    });
    return;
  }
  send(req, res, 200, "text/html; charset=utf-8", SHELL_HTML, documentHeaders);
}

export function matchSandboxLibraryPath(pathname: string): { name: string; version: string; file: string } | null {
  if (!pathname.startsWith("/libs/") || pathname.includes("//") || pathname.includes("\\") || pathname.includes("..") || pathname.includes("%")) {
    return null;
  }
  const rest = pathname.slice("/libs/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  if (!file || file.endsWith("/")) return null;
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (!/^[A-Za-z0-9./_-]+$/.test(file)) return null;
  const parts = file.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return { name, version, file };
}

function libraryHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  };
}

function commonHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Permissions-Policy": SHELL_PERMISSIONS_POLICY,
  };
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string>,
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": contentType,
    "Content-Length": String(payload.length),
  });
  if (req.method === "HEAD") res.end();
  else res.end(payload);
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
}
