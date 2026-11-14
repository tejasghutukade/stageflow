import { randomUUID } from "node:crypto";
import {
  hostLoginAttemptKey,
  readFrozenHostLoginServers,
} from "../config/hostLoginMcp.js";
import { stageFunctionCallsUseHost } from "../functions/workerIpc.js";
import {
  serveStageMcpCall,
  serveStageMcpList,
  type StageMcpAllowlistStage,
  type StageMcpCallView,
  type StageMcpListView,
} from "./stageMcpHost.js";

const TIMEOUT_MS = 30_000;

export type StageMcpCallRequest = {
  runId?: string;
  stageId: string;
  attempt?: number;
  stage: StageMcpAllowlistStage;
  server: string;
  tool: string;
  arguments: unknown;
  signal?: AbortSignal;
};

type McpHostTransport = {
  connected?: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message" | "disconnect", listener: (message?: unknown) => void): unknown;
  once(event: "disconnect", listener: () => void): unknown;
};

type McpWire = {
  type?: string;
  requestId?: string;
  result?: StageMcpCallView | StageMcpListView;
};

function denied(): StageMcpCallView {
  return { ok: false, code: "permission_denied", message: "permission_denied" };
}

function roundTrip(
  type: "mcp.call" | "mcp.list",
  input: unknown,
  transport: McpHostTransport,
): Promise<StageMcpCallView | StageMcpListView> {
  return new Promise((resolve) => {
    if (transport.connected === false || typeof transport.send !== "function") {
      resolve(denied());
      return;
    }
    const requestId = randomUUID();
    let settled = false;
    const finish = (result: StageMcpCallView | StageMcpListView): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.off("message", receive);
      transport.off("disconnect", disconnected);
      resolve(result);
    };
    const disconnected = (): void => {
      finish({ ok: false, code: "cancelled", message: "cancelled" });
    };
    const receive = (message: unknown): void => {
      const response = message as McpWire;
      if (response?.type !== "mcp.response" || response.requestId !== requestId || response.result === undefined) return;
      finish(response.result);
    };
    const timer = setTimeout(disconnected, TIMEOUT_MS);
    transport.on("message", receive);
    transport.once("disconnect", disconnected);
    const payload = input === undefined
      ? { type, requestId }
      : { type, requestId, input };
    try {
      transport.send(payload, (error) => {
        if (error) disconnected();
      });
    } catch {
      disconnected();
    }
  });
}

function processTransport(): McpHostTransport {
  return process as unknown as McpHostTransport;
}

export function stageMcpCallBody(
  input: unknown,
): { server: string; tool: string; arguments: unknown } | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const server = (input as { server?: unknown }).server;
  const tool = (input as { tool?: unknown }).tool;
  if (typeof server !== "string" || server.length === 0 || server.length > 200) return undefined;
  if (typeof tool !== "string" || tool.length === 0 || tool.length > 200) return undefined;
  const args = (input as { arguments?: unknown }).arguments;
  return { server, tool, arguments: args === undefined ? {} : args };
}

export function isStageMcpMessage(
  message: unknown,
): message is { type: "mcp.list" | "mcp.call" | "mcp.cancel"; requestId?: unknown; input?: unknown } {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return type === "mcp.list" || type === "mcp.call" || type === "mcp.cancel";
}

export async function callStageMcpTool(
  input: StageMcpCallRequest,
  transport?: McpHostTransport,
): Promise<StageMcpCallView> {
  const body = { server: input.server, tool: input.tool, arguments: input.arguments };
  if (transport !== undefined) return roundTrip("mcp.call", body, transport) as Promise<StageMcpCallView>;
  if (stageFunctionCallsUseHost()) return roundTrip("mcp.call", body, processTransport()) as Promise<StageMcpCallView>;
  const controller = new AbortController();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return serveStageMcpCall({
    frozen: readFrozenHostLoginServers(hostLoginAttemptKey({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
    })),
    stage: input.stage,
    server: input.server,
    tool: input.tool,
    arguments: input.arguments,
    signal: controller.signal,
  });
}

export async function listStageMcpTools(
  input: {
    runId?: string;
    stageId: string;
    attempt?: number;
    stage: StageMcpAllowlistStage;
  },
  transport?: McpHostTransport,
): Promise<StageMcpListView> {
  if (transport !== undefined) return roundTrip("mcp.list", undefined, transport) as Promise<StageMcpListView>;
  if (stageFunctionCallsUseHost()) return roundTrip("mcp.list", undefined, processTransport()) as Promise<StageMcpListView>;
  const controller = new AbortController();
  return serveStageMcpList({
    frozen: readFrozenHostLoginServers(hostLoginAttemptKey({
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
    })),
    stage: input.stage,
    signal: controller.signal,
  });
}
