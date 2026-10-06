import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentPort } from "../../src/agent/port.js";
import { startUiServer } from "../../src/server/http.js";
import type { HttpHostEnvelope } from "../../src/server/createHttpHost.js";
import type { RunStore } from "../../src/runstore/port.js";
import type { EnsureGlobalServiceResult } from "../../src/server/ensureGlobalService.js";

/**
 * Never actually spawns anything — pass this as `ensureService` when the
 * test has already started a real (in-process, ephemeral-port) service
 * itself, so `runRunCommand`/`runRunsCommand` skip straight to using it.
 */
export const alreadyUp: () => Promise<EnsureGlobalServiceResult> = async () => ({
  ok: true,
  alreadyRunning: true,
});

export type TestInProcessService = {
  server: HttpHostEnvelope;
  baseUrl: string;
  stop: () => Promise<void>;
};

/**
 * Starts a real `startUiServer` in-process, bound to an ephemeral port, on
 * top of the given store — this is "the global service" as far as
 * `runRunCommand`/`runRunsCommand`'s HTTP client code is concerned when
 * given `hostBaseUrl: service.baseUrl` and `ensureService: alreadyUp`.
 */
export async function startTestService(
  store: RunStore,
  agent: AgentPort,
  cwd: string,
): Promise<TestInProcessService> {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "sf-test-service-"));
  const server = await startUiServer({
    agent,
    cwd,
    store,
    port: 0,
    uiDistDir: path.join(scratchRoot, "missing-ui"),
    mcpStateless: true,
  });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
