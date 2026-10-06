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
import {
  installShutdownController,
  makeDrainableHostFromOptional,
  type ShutdownController,
} from "./shutdown.js";

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
): Promise<HttpHostEnvelope & { shutdown: ShutdownController }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const boot = await bootstrapStageflowHost(options as StageflowHostOptions);
  const { cwd, agentDir, rootDir } = boot;
  const providerAuthContext = boot.providerAuthContext;
  const allowedHosts = options.allowedHosts ?? resolveAllowedHosts();
  const controlTokens = options.controlTokens ?? loadControlTokens();

  let shutdown: ShutdownController | undefined;
  const routes =
    boot.serveBlocked !== undefined ||
    boot.manager === undefined ||
    boot.store === undefined
      ? async () => false
      : createOperatorRoutes({
          manager: boot.manager,
          store: boot.store,
          cwd,
          agentDir,
          rootDir,
          providerAuthContext,
          allowedHosts,
          controlTokens,
          getShutdown: () => shutdown,
        });
  const envelope = await createHttpHost({
    boot,
    host,
    port,
    allowedHosts,
    controlTokens,
    requestTimeoutMs: options.requestTimeoutMs,
    maxConnections: options.maxConnections,
    routes,
  });
  shutdown = installShutdownController({
    server: envelope.server,
    host: makeDrainableHostFromOptional(envelope.manager, envelope.store),
  });
  envelope.server.on("close", () => {
    shutdown?.uninstall();
  });
  return { ...envelope, shutdown };
}

export { DEFAULT_PORT };
