import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createRunChangeBus } from "../src/runtime/runChangeBus.js";

const mockState = vi.hoisted(() => ({
  mode: "fail-before-register" as
    | "fail-before-register"
    | "register-then-fail",
  transportClose: vi.fn(async () => undefined),
  serverClose: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/node", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@modelcontextprotocol/node")
  >();
  return {
    ...actual,
    NodeStreamableHTTPServerTransport: class {
      sessionId: string | undefined;
      onclose: (() => void) | undefined;
      #opts: {
        onsessioninitialized?: (id: string) => void;
      };

      constructor(opts: {
        onsessioninitialized?: (id: string) => void;
      } = {}) {
        this.#opts = opts;
      }

      close = mockState.transportClose;

      async handleRequest(): Promise<void> {
        if (mockState.mode === "fail-before-register") {
          throw new Error("handleRequest failed before session");
        }
        const id = "test-session-id";
        this.sessionId = id;
        this.#opts.onsessioninitialized?.(id);
        throw new Error("handleRequest failed after session");
      }
    },
  };
});

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@modelcontextprotocol/server")
  >();
  return {
    ...actual,
    McpServer: class {
      server = {
        sendResourceUpdated: vi.fn(async () => undefined),
        sendResourceListChanged: vi.fn(async () => undefined),
      };
      connect = mockState.connect;
      close = mockState.serverClose;
    },
  };
});

const { registerMcpToolsMock } = vi.hoisted(() => ({
  registerMcpToolsMock: vi.fn(),
}));

vi.mock("../src/mcp/tools.js", () => ({
  registerMcpTools: registerMcpToolsMock,
}));

vi.mock("../src/mcp/resources.js", () => ({
  registerRunResources: vi.fn(),
  runResourceUri: (runId: string) => `stageflow://runs/${runId}`,
}));

import { createMcpHttpHandler } from "../src/mcp/server.js";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
});

async function postInitialize(
  handler: ReturnType<typeof createMcpHttpHandler>,
  query = "",
): Promise<{ status: number; error?: unknown; body?: unknown }> {
  const server = createServer((req, res) => {
    req.url = `/${query}`;
    void handler.handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no addr");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initializeBody,
    });
    const text = await res.text();
    let body: unknown;
    if (text.startsWith("{")) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("MCP stateful initialize cleanup", () => {
  afterEach(() => {
    mockState.transportClose.mockClear();
    mockState.serverClose.mockClear();
    mockState.connect.mockClear();
    registerMcpToolsMock.mockClear();
    mockState.mode = "fail-before-register";
  });

  it("closes transport and server when handleRequest fails before session registration", async () => {
    mockState.mode = "fail-before-register";
    const handler = createMcpHttpHandler({
      manager: {} as never,
      store: {} as never,
      cwd: "/tmp",
      runChangeBus: createRunChangeBus(),
    });

    await postInitialize(handler);

    expect(mockState.transportClose).toHaveBeenCalledTimes(1);
    expect(mockState.serverClose).toHaveBeenCalledTimes(1);

    await handler.close();
    expect(mockState.transportClose).toHaveBeenCalledTimes(1);
    expect(mockState.serverClose).toHaveBeenCalledTimes(1);
  });

  it("leaves registered session for disposeSession when handleRequest fails after registration", async () => {
    mockState.mode = "register-then-fail";
    const handler = createMcpHttpHandler({
      manager: {} as never,
      store: {} as never,
      cwd: "/tmp",
      runChangeBus: createRunChangeBus(),
    });

    await postInitialize(handler);

    expect(mockState.transportClose).not.toHaveBeenCalled();
    expect(mockState.serverClose).not.toHaveBeenCalled();

    await handler.close();
    expect(mockState.transportClose).toHaveBeenCalledTimes(1);
    expect(mockState.serverClose).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for unknown toolsets at initialize without registering a session", async () => {
    const handler = createMcpHttpHandler({
      manager: {} as never,
      store: {} as never,
      cwd: "/tmp",
      runChangeBus: createRunChangeBus(),
    });

    const init = await postInitialize(handler, "?toolsets=nope");

    expect(init.status).toBe(400);
    expect(init.body).toMatchObject({
      error: { message: expect.stringContaining("nope") },
    });
    expect(mockState.connect).not.toHaveBeenCalled();
    expect(registerMcpToolsMock).not.toHaveBeenCalled();
    await handler.close();
  });
});
