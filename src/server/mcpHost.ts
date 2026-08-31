import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { RunStoreKind } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import {
  bootstrapStageflowHost,
  type StageflowHostOptions,
} from "./bootstrap.js";

const DEFAULT_PORT = 3847;

export type McpServerOptions = {
  agent: AgentPort;
  cwd?: string;
  agentDir?: string;
  rootDir?: string;
  store?: RunStore;
  storeKind?: RunStoreKind;
  port?: number;
  host?: string;
  maxConcurrent?: number;
  providerAuthContext?: ProviderAuthContext;
  mcpStateless?: boolean;
  runChangeBus?: RunChangeBus;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startMcpServer(options: McpServerOptions): Promise<{
  server: Server;
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  manager: RunManager;
  store: RunStore;
  runChangeBus: RunChangeBus;
  mcpStateless: boolean;
}> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);
  const validateMcpHost = localhostHostValidation();
  const validateMcpOrigin = localhostOriginValidation();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    if (pathname === "/mcp") {
      if (!validateMcpHost(req, res) || !validateMcpOrigin(req, res)) {
        return;
      }
      try {
        await boot.mcpHandler.handle(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      json(res, 200, boot.manager.getHealth());
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  server.requestTimeout = 0;

  server.on("close", () => {
    void boot.mcpHandler.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const boundPort =
    address && typeof address !== "string" ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  return {
    server,
    port: boundPort,
    host,
    url,
    mcpUrl: `${url}/mcp`,
    manager: boot.manager,
    store: boot.store,
    runChangeBus: boot.runChangeBus,
    mcpStateless: boot.mcpStateless,
  };
}

export { DEFAULT_PORT };
