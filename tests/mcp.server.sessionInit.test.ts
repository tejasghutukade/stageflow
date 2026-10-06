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

vi.mock("../src/mcp/tools.js", () => ({
  registerMcpTools: vi.fn(),
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
): Promise<{ status: number; error?: unknown }> {
  const server = createServer((req, res) => {
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
    return { status: res.status };
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
});
