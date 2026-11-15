import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { createMcpHttpHandler } from "../src/mcp/server.js";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";
import { startUiServer } from "../src/server/http.js";
import { recordMcpTools } from "../src/toolkit/record.js";
import { TOOL_META, TOOLSETS, toolsInToolset } from "../src/toolkit/meta.js";
import { toolsetIds, unknownToolsetsMessage } from "../src/mcp/toolsets.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { mcpCall } from "./helpers/mcpCall.js";

const CORE_TOOLS = [...toolsInToolset("core")].sort();
const ALL_TOOLS = Object.keys(TOOL_META).sort();

async function parseSseJson(text: string): Promise<unknown> {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`no SSE data: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice("data: ".length)) as unknown;
}

async function mcpInitialize(base: string, query = ""): Promise<{ sessionId: string; status: number; body: unknown }> {
  const res = await fetch(`${base}/mcp${query}`, {
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
        capabilities: {},
        clientInfo: { name: "stageflow-test", version: "0.0.0" },
      },
    }),
  });
  const text = await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    return { sessionId: "", status: res.status, body: text ? JSON.parse(text) : null };
  }
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
  return { sessionId, status: res.status, body: await parseSseJson(text) };
}

async function mcpSessionListTools(base: string, sessionId: string, query = ""): Promise<string[]> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const message = (await parseSseJson(await res.text())) as {
    result?: { tools: Array<{ name: string }> };
  };
  return (message.result?.tools ?? []).map((tool) => tool.name).sort();
}

async function statelessToolsList(base: string, query = ""): Promise<{ status: number; names: string[]; error?: unknown }> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    try {
      return { status: res.status, names: [], error: JSON.parse(text) };
    } catch {
      return { status: res.status, names: [], error: text };
    }
  }
  const message = (await parseSseJson(text)) as {
    result?: { tools: Array<{ name: string }> };
  };
  return { status: res.status, names: (message.result?.tools ?? []).map((tool) => tool.name).sort() };
}

async function mcpToolCallPayload(
  base: string,
  sessionId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  const message = (await parseSseJson(await res.text())) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = message.result?.content?.[0]?.text;
  if (!text) throw new Error(`no payload for ${name}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function mcpToolCall(
  base: string,
  sessionId: string | undefined,
  name: string,
  query = "",
): Promise<{ status: number; errorMessage?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  const message = (await parseSseJson(await res.text())) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  if (message.error?.message) {
    return { status: res.status, errorMessage: message.error.message };
  }
  return { status: res.status, errorMessage: message.result?.content?.[0]?.text };
}

describe("MCP connect-time toolsets", () => {
  let httpServer: Server | undefined;
  let handler: ReturnType<typeof createMcpHttpHandler> | undefined;

  afterEach(async () => {
    if (handler) await handler.close();
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    httpServer = undefined;
    handler = undefined;
  });

  async function startStatefulHost(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-toolsets-"));
    const store = createRunStore({ rootDir: home });
    handler = createMcpHttpHandler({
      manager: {} as never,
      store,
      cwd: FIXTURES_ROOT,
      runChangeBus: createRunChangeBus(),
    });
    httpServer = createServer((req, res) => {
      void handler!.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer!.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    return `http://127.0.0.1:${address.port}`;
  }

  it("stateful bare /mcp lists exactly core tools", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base);
    expect(await mcpSessionListTools(base, sessionId)).toEqual(CORE_TOOLS);
  });

  it("stateful ?toolsets=evals lists core plus eval tools", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base, "?toolsets=evals");
    const expected = [...new Set([...CORE_TOOLS, ...toolsInToolset("evals")])].sort();
    expect(await mcpSessionListTools(base, sessionId)).toEqual(expected);
    expect(toolsInToolset("evals")).toHaveLength(14);
  });

  it("stateful ?toolsets=all lists all 57 tools", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base, "?toolsets=all");
    expect(await mcpSessionListTools(base, sessionId)).toEqual(ALL_TOOLS);
  });

  it("stateful session keeps eval tools when later requests omit query", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base, "?toolsets=evals");
    const expected = [...new Set([...CORE_TOOLS, ...toolsInToolset("evals")])].sort();
    expect(await mcpSessionListTools(base, sessionId)).toEqual(expected);
    expect(await mcpSessionListTools(base, sessionId, "")).toEqual(expected);
  });

  it("stateful session ignores a later ?toolsets=all upgrade on the same session id", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base);
    expect(await mcpSessionListTools(base, sessionId)).toEqual(CORE_TOOLS);
    expect(await mcpSessionListTools(base, sessionId, "?toolsets=all")).toEqual(CORE_TOOLS);
  });

  it("stateful ?toolsets=nope returns HTTP 400 listing valid toolsets", async () => {
    const base = await startStatefulHost();
    const init = await mcpInitialize(base, "?toolsets=nope");
    expect(init.status).toBe(400);
    expect(init.body).toMatchObject({
      error: { message: unknownToolsetsMessage(["nope"]) },
    });
  });

  it("stateless bare /mcp lists core only", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-toolsets-stateless-"));
    const store = createRunStore({ rootDir: home });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: FIXTURES_ROOT,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    httpServer = started.server;
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;
    const list = await statelessToolsList(base);
    expect(list.status).toBe(200);
    expect(list.names).toEqual(CORE_TOOLS);
  });

  it("mcpCall with query \"\" cannot reach get_eval on a stateless core host", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-toolsets-mcpcall-bare-"));
    const store = createRunStore({ rootDir: home });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: FIXTURES_ROOT,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    httpServer = started.server;
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;
    const core = await mcpCall(base, "list_catalog", { kind: "pipelines" }, { query: "" });
    expect(core.raw.error).toBeUndefined();
    expect(core.isError).toBe(false);
    const missing = await mcpCall(base, "get_eval", {}, { query: "" });
    expect(JSON.stringify(missing.raw.error ?? missing.payload)).toMatch(/not found/i);
  });

  it("stateless ?toolsets=all lists all tools", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-toolsets-stateless-all-"));
    const store = createRunStore({ rootDir: home });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: FIXTURES_ROOT,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    httpServer = started.server;
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;
    const list = await statelessToolsList(base, "?toolsets=all");
    expect(list.status).toBe(200);
    expect(list.names).toEqual(ALL_TOOLS);
  });

  it("stateless ?toolsets=nope returns HTTP 400 on tools/call", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-toolsets-stateless-bad-"));
    const store = createRunStore({ rootDir: home });
    const started = await startUiServer({
      agent: scriptedFakeAgent([]),
      cwd: FIXTURES_ROOT,
      rootDir: home,
      store,
      port: 0,
      uiDistDir: path.join(home, "missing-ui"),
      mcpStateless: true,
    });
    httpServer = started.server;
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${address.port}`;
    const res = await fetch(`${base}/mcp?toolsets=nope`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_eval", arguments: {} },
      }),
    });
    const body = JSON.parse(await res.text()) as { error?: { message?: string } };
    expect(res.status).toBe(400);
    expect(body.error?.message).toBe(unknownToolsetsMessage(["nope"]));
    for (const id of toolsetIds()) {
      expect(body.error?.message).toContain(id);
    }
  });

  it("get_eval on a core-only session returns not found", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base);
    const call = await mcpToolCall(base, sessionId, "get_eval");
    expect(call.errorMessage).toMatch(/not found/i);
  });

  it("get_started exposes eval toolset reconnect URL on a core-only session", async () => {
    const base = await startStatefulHost();
    const { sessionId } = await mcpInitialize(base);
    const payload = await mcpToolCallPayload(base, sessionId, "get_started");
    const unloaded = payload.unloaded_toolsets as Array<{ id: string; reconnect_url: string }>;
    const evals = unloaded.find((row) => row.id === "evals");
    expect(evals?.reconnect_url).toBe(`${base}/mcp?toolsets=evals`);
    expect(unloaded.map((row) => row.id).sort()).toEqual(
      TOOLSETS.filter((entry) => entry.id !== "core")
        .map((entry) => entry.id)
        .sort(),
    );
  });

  it("recordMcpTools returns all 57 tools regardless of session selection", () => {
    const names = recordMcpTools({
      cwd: process.cwd(),
      store: {} as never,
      manager: {} as never,
    })
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(ALL_TOOLS);
  });
});