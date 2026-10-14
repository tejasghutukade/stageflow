import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { releaseChannelHost } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";
import type { RunStore } from "../src/runstore/port.js";

const SECRET = "super-secret-token-value";
const YAML = "version: 1\nconnections:\n  - id: ops\n    provider: fake\n    displayName: Ops\n    config: { inbox: ops@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n  - id: off\n    provider: fake\n    enabled: false\n    config: { inbox: off@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n";

describe("/api/connections", () => {
  let root: string;
  let cleanupRoot: () => Promise<void>;
  let home: string;
  let store: RunStore;
  let base: string;
  let close: () => Promise<void>;
  let provider: ReturnType<typeof fakeChannelProvider>;

  async function boot(connections: string): Promise<void> {
    await writeFile(path.join(root, "connections.yaml"), connections);
    const { server } = await startUiServer({
      agent: { startStage: async () => createCompletedOnlyStageHandle() },
      cwd: root, rootDir: home, store, port: 0, uiDistDir: path.join(home, "missing-ui"), mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    base = `http://127.0.0.1:${address.port}`;
    close = async () => { await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))); };
  }

  beforeEach(async () => {
    const setup = await initTempGitRepo();
    root = setup.root;
    cleanupRoot = setup.cleanup;
    await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n");
    clearFindProjectRootCacheForTests();
    home = await mkdtemp(path.join(tmpdir(), "sf-conn-"));
    store = createRunStore({ rootDir: home, openerMode: "migrate" });
    await store.ensureProject(root);
    provider = fakeChannelProvider();
    registerChannelProvider(provider);
    process.env.CH_TEST_TOKEN = SECRET;
  });
  afterEach(async () => {
    unregisterChannelProvider("fake");
    delete process.env.CH_TEST_TOKEN;
    if (close) await close();
    await releaseChannelHost(root);
    clearFindProjectRootCacheForTests();
    await store.close();
    await cleanupRoot();
    await rm(home, { recursive: true, force: true });
  });

  it("lists connections with identity and no secrets, then shows health after a check", async () => {
    await boot(YAML);
    const first = await (await fetch(`${base}/api/connections`)).json();
    expect(first.connections.map((c: { id: string }) => c.id)).toEqual(["ops", "off"]);
    expect(first.connections[0]).toMatchObject({ id: "ops", provider: "fake", displayName: "Ops", enabled: true, identity: "ops@b.test" });
    expect(first.connections[1]).toMatchObject({ id: "off", enabled: false });
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(JSON.stringify(first)).not.toContain("CH_TEST_TOKEN");

    const checked = await fetch(`${base}/api/connections/ops/check`, { method: "POST", headers: { origin: base } });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ state: "ok" });
    const second = await (await fetch(`${base}/api/connections`)).json();
    const ops = second.connections.find((c: { id: string }) => c.id === "ops");
    expect(ops.health).toMatchObject({ state: "ok" });
  });

  it("reports a failed check with a code and keeps the secret out", async () => {
    await boot(YAML);
    provider.health = "failed";
    const body = await (await fetch(`${base}/api/connections/ops/check`, { method: "POST", headers: { origin: base } })).json();
    expect(body).toMatchObject({ state: "failed", error: { code: "CHANNEL_AUTH_FAILED", retryable: false } });
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("returns 404 for an unknown or disabled connection", async () => {
    await boot(YAML);
    for (const id of ["nope", "off"]) {
      const response = await fetch(`${base}/api/connections/${id}/check`, { method: "POST", headers: { origin: base } });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "CHANNEL_NOT_FOUND" });
    }
  });

  it("refuses a check without a same-origin header", async () => {
    await boot(YAML);
    const response = await fetch(`${base}/api/connections/ops/check`, { method: "POST" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(provider.checkCalls).toBe(0);
  });

  it("starts the host and reports a code when connections.yaml is invalid", async () => {
    await boot("version: 1\nconnections:\n  - id: ops\n    provider: nope\n");
    const response = await fetch(`${base}/api/connections`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED" });
  });

  it("lists nothing, without an error, when there is no connections.yaml", async () => {
    await rm(path.join(root, "connections.yaml"), { force: true });
    const { server } = await startUiServer({
      agent: { startStage: async () => createCompletedOnlyStageHandle() },
      cwd: root, rootDir: home, store, port: 0, uiDistDir: path.join(home, "missing-ui"), mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    base = `http://127.0.0.1:${address.port}`;
    close = async () => { await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))); };
    expect(await (await fetch(`${base}/api/connections`)).json()).toEqual({ connections: [] });
  });
});
