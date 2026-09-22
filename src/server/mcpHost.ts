import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { RunStoreKind } from "../runstore/createStore.js";
import type { RunStore } from "../runstore/port.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import {
  bootstrapStageflowHost,
  type StageflowHostOptions,
} from "./bootstrap.js";
import type { AllowedHosts } from "./allowedHosts.js";
import { resolveAllowedHosts } from "./allowedHosts.js";
import type { ControlTokens } from "./controlToken.js";
import { loadControlTokens } from "./controlToken.js";
import {
  createHttpHost,
  DEFAULT_PORT,
  type HttpHostEnvelope,
} from "./createHttpHost.js";
import { createOperatorRoutes } from "./http.js";

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
  allowedHosts?: AllowedHosts;
  controlTokens?: ControlTokens;
  requestTimeoutMs?: number;
  maxConnections?: number;
};

export async function startMcpServer(
  options: McpServerOptions,
): Promise<HttpHostEnvelope> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);
  const { manager, store, cwd, agentDir, rootDir } = boot;
  const providerAuthContext = boot.providerAuthContext;
  const allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = options.controlTokens ?? loadControlTokens();

  return createHttpHost({
    boot,
    host,
    port,
    allowedHosts,
    controlTokens,
    requestTimeoutMs: options.requestTimeoutMs,
    maxConnections: options.maxConnections,
    // Headless daemon: same REST API surface as `sf ui` (this is what lets
    // `sf run`/`sf runs *` talk to an auto-started `sf mcp` over HTTP), just
    // without serving the console's static UI files.
    routes: createOperatorRoutes({
      manager,
      store,
      cwd,
      agentDir,
      rootDir,
      providerAuthContext,
      allowedHosts,
      controlTokens,
    }),
  });
}

export { DEFAULT_PORT };
