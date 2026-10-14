import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";
import type { RunStore } from "../src/runstore/port.js";

const IO = { io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } } };
const inline = (connection = "ops") => ({
  id: "inline-channels",
  stages: [{ id: "a", system_prompt: "hi", model: "anthropic/claude-sonnet-4-5", ...IO,
    channels: [{ connection, to: "#general", operations: ["send"] }] }],
});

describe("preflight and start_run with channels", () => {
  let catalogRoot: string;
  let cleanupCatalogRoot: () => Promise<void>;
  let home: string;
  let store: RunStore;
  let base: string;
  let close: () => Promise<void>;
  let provider: ReturnType<typeof fakeChannelProvider>;

  beforeAll(async () => {
    const setup = await initTempGitRepo();
    catalogRoot = setup.root;
    cleanupCatalogRoot = setup.cleanup;
    await writeFile(path.join(catalogRoot, "connections.yaml"), "version: 1\nconnections:\n  - id: ops\n    provider: fake\n    config: { inbox: ops@b.test }\n    secrets: { token: env:CH_TEST_TOKEN }\n");
    await writeFile(path.join(catalogRoot, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n");
    clearFindProjectRootCacheForTests();
    home = await mkdtemp(path.join(tmpdir(), "sf-mcp-channels-"));
    store = createRunStore({ rootDir: home, openerMode: "migrate" });
    await store.ensureProject(catalogRoot);
    const { server } = await startUiServer({
      agent: { startStage: async () => createCompletedOnlyStageHandle() },
      cwd: catalogRoot, rootDir: home, store, port: 0, uiDistDir: path.join(home, "missing-ui"), mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP");
    base = `http://127.0.0.1:${address.port}`;
    close = async () => { await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))); };
  });
  afterAll(async () => {
    clearFindProjectRootCacheForTests();
    if (close) await close();
    if (store) await store.close();
    if (cleanupCatalogRoot) await cleanupCatalogRoot();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    provider = fakeChannelProvider();
    registerChannelProvider(provider);
    process.env.CH_TEST_TOKEN = "super-secret-token-value";
  });
  afterEach(() => {
    unregisterChannelProvider("fake");
    delete process.env.CH_TEST_TOKEN;
  });

  it("preflight reports a failed connection as channel_check_failed without creating a Run", async () => {
    provider.health = "failed";
    const before = await store.listRuns();
    const result = await mcpCall(base, "preflight", { pipeline: inline() });
    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.code).toBe("channel_check_failed");
    expect(result.payload.checks.find((c: { kind: string }) => c.kind === "channel")).toEqual(expect.objectContaining({
      kind: "channel", status: "channel_check_failed", connection: "ops", channelCode: "CHANNEL_AUTH_FAILED", retryable: false,
    }));
    expect(JSON.stringify(result.payload)).not.toContain("super-secret");
    expect((await store.listRuns()).length).toBe(before.length);
  });

  it("preflight passes when the connection is healthy", async () => {
    const result = await mcpCall(base, "preflight", { pipeline: inline() });
    expect(result.payload.ok).toBe(true);
    expect(result.payload.code).toBeUndefined();
    expect(provider.checkCalls).toBe(1);
  });

  it("start_run blocks the run with the same code and creates no Run", async () => {
    provider.health = "failed";
    const before = await store.listRuns();
    const result = await mcpCall(base, "start_run", { pipeline: inline(), task: { id: "t", goal: "g" } });
    expect(result.isError).toBe(true);
    expect(result.payload.code).toBe("channel_check_failed");
    expect(provider.sent).toHaveLength(0);
    expect((await store.listRuns()).length).toBe(before.length);
  });

  it("start_run fails static validation first when the connection is not defined", async () => {
    const result = await mcpCall(base, "start_run", { pipeline: inline("ghost"), task: { id: "t", goal: "g" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("not defined in connections.yaml");
    expect(provider.checkCalls).toBe(0);
  });

  it("accepts pipeline-level channels on an inline pipeline", async () => {
    const result = await mcpCall(base, "preflight", { pipeline: {
      id: "inline-defaults", channels: [{ connection: "ops", to: "#general", operations: ["send"] }],
      stages: [{ id: "a", system_prompt: "hi", model: "anthropic/claude-sonnet-4-5", ...IO }],
    } });
    expect(result.payload.ok).toBe(true);
    expect(provider.checkCalls).toBe(1);
  });
});
