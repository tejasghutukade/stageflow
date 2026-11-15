import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { createMcpHttpHandler } from "../src/mcp/server.js";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";
import { recordMcpTools } from "../src/toolkit/record.js";
import { TOOLSETS, TOOL_META, toolsInToolset } from "../src/toolkit/meta.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const CORE_TOOLS = new Set(toolsInToolset("core"));
const NON_CORE_TOOL_NAMES = Object.keys(TOOL_META)
  .filter((name) => !CORE_TOOLS.has(name))
  .sort();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function parseSseJson(text: string): Promise<unknown> {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no SSE data: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice("data: ".length)) as unknown;
}

async function mcpInitialize(base: string, query = ""): Promise<string> {
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
  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) throw new Error(`initialize failed: ${await res.text()}`);
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

async function getStartedPayload(base: string, sessionId: string): Promise<Record<string, unknown>> {
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
      params: { name: "get_started", arguments: {} },
    }),
  });
  const message = (await parseSseJson(await res.text())) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = message.result?.content?.[0]?.text;
  if (!text) throw new Error("get_started returned no text");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP core tool descriptions", () => {
  it("names no tool outside core in any core tool description", () => {
    const deps = {
      cwd: FIXTURES_ROOT,
      store: {} as never,
      manager: {} as never,
    };
    for (const tool of recordMcpTools(deps)) {
      if (!CORE_TOOLS.has(tool.name)) continue;
      for (const other of NON_CORE_TOOL_NAMES) {
        const pattern = new RegExp(`\\b${escapeRegExp(other)}\\b`);
        expect(tool.description, `${tool.name} mentions ${other}`).not.toMatch(pattern);
      }
    }
  });
});

describe("get_started toolset discovery", () => {
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

  async function startHost(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-core-desc-"));
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

  it("lists every non-core toolset with reconnect URLs on the session host", async () => {
    const base = await startHost();
    const sessionId = await mcpInitialize(base);
    const payload = await getStartedPayload(base, sessionId);
    const unloaded = payload.unloaded_toolsets as Array<{ id: string; reconnect_url: string }>;
    const expectedIds = TOOLSETS.filter((entry) => entry.id !== "core").map((entry) => entry.id);
    expect(unloaded.map((row) => row.id).sort()).toEqual([...expectedIds].sort());
    for (const row of unloaded) {
      expect(row.reconnect_url).toBe(`${base}/mcp?toolsets=${row.id}`);
    }
    const loaded = payload.loaded_toolsets as Array<{ id: string }>;
    expect(loaded.map((row) => row.id)).toEqual(["core"]);
  });

  it("lists no unloaded toolsets when the session loaded all", async () => {
    const base = await startHost();
    const sessionId = await mcpInitialize(base, "?toolsets=all");
    const payload = await getStartedPayload(base, sessionId);
    expect(payload.unloaded_toolsets).toEqual([]);
    expect((payload.loaded_toolsets as Array<{ id: string }>).map((row) => row.id).sort()).toEqual(
      TOOLSETS.map((entry) => entry.id).sort(),
    );
  });
});