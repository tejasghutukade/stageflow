import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const credentialRoot = mkdtempSync(path.join(tmpdir(), "sf-conn-cred-"));
process.env.STAGEFLOW_CREDENTIAL_HOME = credentialRoot;
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
    expect(await response.json()).toEqual({ connections: [], error: "CHANNEL_PROVIDER_UNSUPPORTED", limits: { channelsPerStage: 1 } });
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
    expect(await (await fetch(`${base}/api/connections`)).json()).toEqual({ connections: [], limits: { channelsPerStage: 1 } });
  });

  describe("editing", () => {
    const post = (url: string, body: unknown, method = "POST", origin: string | null = base) =>
      fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const draft = (extra: object = {}) => ({ provider: "fake", id: "new-box", config: { inbox: "n@b.test" }, secrets: { token: SECRET }, ...extra });

    it("creates, replaces, disables and removes a connection over HTTP without echoing the secret", async () => {
      await boot("version: 1\nconnections: []\n");
      const created = await post("/api/connections", draft());
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody).toMatchObject({ id: "new-box", health: { state: "ok" } });
      expect(JSON.stringify(createdBody)).not.toContain(SECRET);
      const yaml = await readFile(path.join(root, "connections.yaml"), "utf8");
      expect(yaml).toContain("store:connection.new-box.token");
      expect(yaml).not.toContain(SECRET);

      const listing = await (await fetch(`${base}/api/connections`)).json();
      expect(listing.connections[0]).toMatchObject({ id: "new-box", secrets: { token: "store" }, health: { state: "ok" } });
      expect(JSON.stringify(listing)).not.toContain(SECRET);

      const replaced = await post("/api/connections/new-box", { secrets: { token: "another-secret-value" } }, "PATCH");
      expect(replaced.status).toBe(200);
      expect(JSON.stringify(await replaced.json())).not.toContain("another-secret");
      expect((await post("/api/connections/new-box", { enabled: false }, "PATCH")).status).toBe(200);
      expect((await (await fetch(`${base}/api/connections`)).json()).connections[0].enabled).toBe(false);

      expect((await post("/api/connections/new-box", undefined, "DELETE")).status).toBe(200);
      expect((await (await fetch(`${base}/api/connections`)).json()).connections).toEqual([]);
      expect((await post("/api/connections/new-box", undefined, "DELETE")).status).toBe(404);
    });

    it("tests entered values without saving", async () => {
      await boot("version: 1\nconnections: []\n");
      provider.health = "failed";
      const response = await post("/api/connections/test", draft());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "failed", error: { code: "CHANNEL_AUTH_FAILED" } });
      expect((await (await fetch(`${base}/api/connections`)).json()).connections).toEqual([]);
    });

    it.each([
      [draft({ provider: "nope" }), 400, "CHANNEL_PROVIDER_UNSUPPORTED"],
      [draft({ config: { inbox: 3 } }), 400, "CHANNEL_INVALID_INPUT"],
      [draft({ secrets: {} }), 400, "CHANNEL_INVALID_INPUT"],
    ])("answers invalid input with only a code", async (body, status, code) => {
      await boot("version: 1\nconnections: []\n");
      const response = await post("/api/connections", body);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ code });
      expect(text).not.toContain(SECRET);
    });

    it("answers a duplicate id with 409 and bad JSON with 400", async () => {
      await boot("version: 1\nconnections: []\n");
      expect((await post("/api/connections", draft())).status).toBe(201);
      expect((await post("/api/connections", draft())).status).toBe(409);
      const bad = await fetch(`${base}/api/connections`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{nope" });
      expect(bad.status).toBe(400);
    });

    it("serves provider descriptions and the error catalogue without secrets", async () => {
      await boot("version: 1\nconnections: []\n");
      const response = await fetch(`${base}/api/connections/meta`);
      expect(response.status).toBe(200);
      const meta = await response.json();
      const ids = meta.providers.map((provider: { id: string }) => provider.id);
      expect(ids).toEqual(expect.arrayContaining(["agentmail", "slack", "telegram", "imessage", "whatsapp"]));
      const agentmail = meta.providers.find((provider: { id: string }) => provider.id === "agentmail");
      expect(agentmail.fields.map((field: { key: string }) => field.key)).toEqual(["inbox", "region", "apiKey"]);
      expect(meta.errors.CHANNEL_RECIPIENT_REJECTED.reason).toMatch(/will not message/);
      expect(meta.errors.CHANNEL_NOT_FOUND.status).toBeUndefined();
      expect(JSON.stringify(meta)).not.toContain(SECRET);
    });

    it("validates a pinned recipient with the provider\'s own rules, without network or secrets", async () => {
      await boot(YAML);
      const call = (id: string, body: unknown) => post(`/api/connections/${id}/validate-target`, body);
      expect(await (await call("ops", { to: "C123" })).json()).toEqual({ ok: true });
      expect(await (await call("ops", { to: "C123", cc: ["x"] })).json()).toEqual({ ok: false, issues: ["target"] });
      expect(await (await call("ops", { to: 42 })).json()).toEqual({ ok: true });
      expect(await (await call("ops", { nope: 1 })).json()).toEqual({ ok: false, issues: ["target"] });
      expect((await call("missing", { to: "x" })).status).toBe(404);
      expect(provider.checkCalls).toBe(0);
    });

    it("refuses edits without a same-origin header and oversized bodies", async () => {
      await boot("version: 1\nconnections: []\n");
      expect((await post("/api/connections", draft(), "POST", null)).status).toBeGreaterThanOrEqual(400);
      expect((await post("/api/connections/x", undefined, "DELETE", null)).status).toBeGreaterThanOrEqual(400);
      const big = await post("/api/connections", draft({ displayName: "x".repeat(70000) }));
      expect(big.status).toBe(413);
      expect((await (await fetch(`${base}/api/connections`)).json()).connections).toEqual([]);
    });
  });
});
