import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { RunStoreKind } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import {
  bootstrapStageflowHost,
  type StageflowHostOptions,
} from "./bootstrap.js";
import {
  createHttpHost,
  DEFAULT_PORT,
  type HttpHostEnvelope,
} from "./createHttpHost.js";

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

export async function startMcpServer(
  options: McpServerOptions,
): Promise<HttpHostEnvelope> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);

  return createHttpHost({
    boot,
    host,
    port,
    routes: async ({ method, pathname, res, json, boot: b }) => {
      if (method === "GET" && pathname === "/api/health") {
        json(res, 200, b.manager.getHealth());
        return true;
      }
      json(res, 404, { error: "Not found" });
      return true;
    },
  });
}

export { DEFAULT_PORT };
