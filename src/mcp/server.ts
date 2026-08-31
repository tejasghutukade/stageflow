import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  isInitializeRequest,
  McpServer,
} from "@modelcontextprotocol/server";
import { registerRunResources, runResourceUri } from "./resources.js";
import { registerMcpTools, type McpToolDeps } from "./tools.js";

export type { McpToolDeps };

export type McpHttpOptions = {
  /** Test/debug escape hatch — per-request create/teardown (no sessions). */
  mcpStateless?: boolean;
};

type SessionEntry = {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  unsubscribeBus?: () => void;
};

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].length > 0) {
    return raw[0];
  }
  return undefined;
}

function attachBusNotifications(
  server: McpServer,
  deps: McpToolDeps,
): (() => void) | undefined {
  const bus = deps.runChangeBus;
  if (!bus) return undefined;
  return bus.on((event) => {
    const uri = runResourceUri(event.runId);
    void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
    if (event.kind === "created") {
      void server.server.sendResourceListChanged().catch(() => undefined);
    }
  });
}

export function createStageflowMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer(
    {
      name: "stageflow",
      version: "0.2.0",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    },
  );
  registerMcpTools(server, deps);
  registerRunResources(server, deps);
  return server;
}

async function handleStatelessMcpRequest(
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

export type McpHttpHandler = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
};

/** Stateful Streamable HTTP session host (product default) or stateless escape hatch. */
export function createMcpHttpHandler(
  deps: McpToolDeps,
  options: McpHttpOptions = {},
): McpHttpHandler {
  const stateless = options.mcpStateless === true;
  const sessions = new Map<string, SessionEntry>();

  async function closeSession(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    entry.unsubscribeBus?.();
    await entry.transport.close().catch(() => undefined);
    await entry.server.close().catch(() => undefined);
  }

  async function handleStateful(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sessionId = sessionIdFromRequest(req);
    const method = req.method ?? "GET";

    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (sessionId) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }

    if (method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error");
        return;
      }
      if (!isInitializeRequest(body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: Session ID required");
        return;
      }

      const server = createStageflowMcpServer(deps);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            server,
            unsubscribeBus: attachBusNotifications(server, deps),
          });
        },
        onsessionclosed: (id) => {
          const entry = sessions.get(id);
          if (!entry) return;
          sessions.delete(id);
          entry.unsubscribeBus?.();
          void entry.server.close().catch(() => undefined);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (!id) return;
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        entry.unsubscribeBus?.();
        void entry.server.close().catch(() => undefined);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    jsonRpcError(res, 400, -32000, "Bad Request: Session ID required");
  }

  return {
    handle: async (req, res) => {
      if (stateless) {
        await handleStatelessMcpRequest(req, res, deps);
        return;
      }
      await handleStateful(req, res);
    },
    close: async () => {
      const ids = [...sessions.keys()];
      await Promise.all(ids.map((id) => closeSession(id)));
    },
  };
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpToolDeps,
): Promise<void> {
  await handleStatelessMcpRequest(req, res, deps);
}

export function resolveMcpStateless(options?: {
  mcpStateless?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options?.mcpStateless === true) return true;
  const env = options?.env ?? process.env;
  return env.STAGEFLOW_MCP_STATELESS === "1";
}
