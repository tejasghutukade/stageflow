import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { startUiServer } from "../src/server/http.js";
import { startMcpServer, DEFAULT_PORT } from "../src/server/mcpHost.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { pipelinePath } from "./helpers/fixturePaths.js";
import { resolveMcpStateless } from "../src/mcp/server.js";
import { runResourceUri } from "../src/mcp/resources.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

let catalogRoot: string;
let cleanupCatalogRoot: () => Promise<void>;

beforeAll(async () => {
  const setup = await initTempGitRepo();
  catalogRoot = setup.root;
  cleanupCatalogRoot = setup.cleanup;
  await cp(path.join(fixtures, "pipelines"), path.join(catalogRoot, "pipelines"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "tasks"), path.join(catalogRoot, "tasks"), {
    recursive: true,
  });
  await cp(path.join(fixtures, "stages"), path.join(catalogRoot, "stages"), {
    recursive: true,
  });
  await writeFile(
    path.join(catalogRoot, "stageflow.yaml"),
    [
      "version: 1",
      "catalog:",
      "  pipelines:",
      "    - pipelines",
      "  tasks:",
      "    - tasks",
      "  patterns:",
      '    pipeline: "*.yaml"',
      '    task: "*.yaml"',
      "",
    ].join("\n"),
  );
  clearFindProjectRootCacheForTests();
});

afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanupCatalogRoot();
});

async function parseSseJson(text: string): Promise<unknown> {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice("data: ".length)) as unknown;
}

async function mcpInitialize(base: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {
          roots: {},
          sampling: {},
        },
        clientInfo: { name: "stageflow-test", version: "0.0.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    const body = await res.text();
    throw new Error(`missing mcp-session-id: ${res.status} ${body.slice(0, 300)}`);
  }
  await res.text();
  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  return sessionId;
}

async function mcpSessionCall(
  base: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });
  const text = await res.text();
  const message = (await parseSseJson(text)) as {
    result?: unknown;
    error?: unknown;
  };
  return { status: res.status, message };
}

async function mcpToolCall(
  base: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const message = (await parseSseJson(text)) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
  };
  const contentText = message.result?.content?.[0]?.text ?? "";
  return {
    status: res.status,
    isError: Boolean(message.result?.isError),
    payload: contentText ? JSON.parse(contentText) : null,
  };
}

describe("MCP Tier 3 sessions", () => {
  it("initialize → session id → get_health; GET SSE accepted; unknown session 404", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-sess-"));
    const store = createRunStore({ rootDir: root });
    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const sessionId = await mcpInitialize(base);
      expect(sessionId.length).toBeGreaterThan(0);

      const health = await mcpToolCall(base, sessionId, "get_health");
      expect(health.isError).toBe(false);
      expect(health.payload.ok).toBe(true);

      const getRes = await fetch(`${base}/mcp`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
      expect(getRes.status).toBe(200);
      expect(
        (getRes.headers.get("content-type") ?? "").includes("text/event-stream"),
      ).toBe(true);
      void getRes.body?.cancel();

      const unknown = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "does-not-exist",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "get_health", arguments: {} },
        }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("stateless escape hatch: tool call without session headers succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-stateless-"));
    const store = createRunStore({ rootDir: root });
    const { server } = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const health = await mcpToolCall(base, undefined, "get_health");
      expect(health.isError).toBe(false);
      expect(health.payload.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("MCP Tier 3 run resources", () => {
  it("list/read run resource; no catalog URI; tool and resource agree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-res-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "emit",
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server } = await startUiServer({
      agent,
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const sessionId = await mcpInitialize(base);
      const started = await mcpToolCall(base, sessionId, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      for (let i = 0; i < 80; i++) {
        const detail = await store.readRun(runId);
        if (detail.status === "succeeded" || detail.status === "failed") break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const listed = await mcpSessionCall(base, sessionId, "resources/list");
      const resources = (
        listed.message as {
          result?: { resources?: Array<{ uri: string }> };
        }
      ).result?.resources ?? [];
      expect(resources.some((r) => r.uri === runResourceUri(runId))).toBe(true);
      expect(
        resources.some((r) => r.uri.includes("catalog/pipelines")),
      ).toBe(false);

      const read = await mcpSessionCall(base, sessionId, "resources/read", {
        uri: runResourceUri(runId),
      });
      const contents = (
        read.message as {
          result?: { contents?: Array<{ text?: string }> };
        }
      ).result?.contents ?? [];
      const resourcePayload = JSON.parse(contents[0]?.text ?? "{}") as {
        status?: string;
        run_id?: string;
      };
      expect(resourcePayload.run_id).toBe(runId);
      expect(resourcePayload).not.toHaveProperty("events");

      const getRun = await mcpToolCall(base, sessionId, "get_run", { runId });
      expect(getRun.isError).toBe(false);
      expect(getRun.payload.status).toBe(resourcePayload.status);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it(
    "subscribe + waiting emits resources/updated on GET SSE",
    { timeout: 20_000 },
    async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-sub-"));
    const store = createRunStore({ rootDir: root });
    const freeTextPrompt = {
      kind: "free_text" as const,
      id: "prompt-1",
      message: "name?",
    };
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server } = await startUiServer({
      agent,
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const sessionId = await mcpInitialize(base);

      const sseRes = await fetch(`${base}/mcp`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
      expect(sseRes.status).toBe(200);

      const reader = sseRes.body?.getReader();
      if (!reader) throw new Error("no SSE body");
      const decoder = new TextDecoder();
      let buffer = "";
      let resolveUpdated: (v: boolean) => void;
      const updatedSeen = new Promise<boolean>((resolve) => {
        resolveUpdated = resolve;
      });
      void (async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes("notifications/resources/updated")) {
            resolveUpdated!(true);
            return;
          }
        }
        resolveUpdated!(false);
      })();

      const started = await mcpToolCall(base, sessionId, "start_run", {
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      const uri = runResourceUri(runId);
      await mcpSessionCall(base, sessionId, "resources/subscribe", { uri });

      for (let i = 0; i < 120; i++) {
        const detail = await store.readRun(runId);
        if (detail.stages.some((s) => s.status === "waiting_for_input")) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const seen = await updatedSeen;
      expect(seen).toBe(true);
      expect(buffer).toContain(uri);
      await reader.cancel().catch(() => undefined);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  },
  );
});

describe("MCP Tier 3 sf mcp host", () => {
  it("startMcpServer serves get_health and /api/health; default port constant", async () => {
    expect(DEFAULT_PORT).toBe(3847);
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-host-"));
    const store = createRunStore({ rootDir: root });
    const { server, mcpUrl, mcpStateless } = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: catalogRoot,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
    });
    expect(mcpStateless).toBe(true);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      expect(mcpUrl).toBe(`${base}/mcp`);
      const healthHttp = await fetch(`${base}/api/health`);
      expect(healthHttp.status).toBe(200);
      const health = await mcpToolCall(base, undefined, "get_health");
      expect(health.isError).toBe(false);
      expect(health.payload.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("resolveMcpStateless honors flag and env", () => {
    expect(resolveMcpStateless({ mcpStateless: true })).toBe(true);
    expect(resolveMcpStateless({ mcpStateless: false, env: {} })).toBe(false);
    expect(
      resolveMcpStateless({
        mcpStateless: false,
        env: { STAGEFLOW_MCP_STATELESS: "1" },
      }),
    ).toBe(true);
  });
});

describe("MCP Tier 3 session dispose", () => {
  it("double handler.close does not throw; bus unsubscribe once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-dispose-"));
    const store = createRunStore({ rootDir: root });
    const bus = createRunChangeBus();
    let unsubCount = 0;
    const originalOn = bus.on.bind(bus);
    bus.on = (listener) => {
      const unsub = originalOn(listener);
      return () => {
        unsubCount += 1;
        unsub();
      };
    };

    const boot = await bootstrapStageflowHost({
      agent: scriptedFakeAgent([]),
      cwd: catalogRoot,
      rootDir: root,
      store,
      runChangeBus: bus,
    });

    const server = createServer((req, res) => {
      void boot.mcpHandler.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      await mcpInitialize(base);
      expect(unsubCount).toBe(0);

      await boot.mcpHandler.close();
      expect(unsubCount).toBe(1);

      await boot.mcpHandler.close();
      expect(unsubCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
