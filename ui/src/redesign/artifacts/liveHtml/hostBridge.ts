import {
  MAX_MESSAGE_BYTES,
  buildBindingUpdated,
  buildInitializeResult,
  bridgeResult,
  parseBridgeMessage,
  type BridgeMessage,
  type HostContext,
} from "../../../../../src/artifacts/bridge/protocol.ts";
import type { ToolCallBody } from "./bindingCalls";

export const SHELL_READY_METHOD = "sf/sandbox-ready";
export const SHELL_LOAD_METHOD = "sf/sandbox-load";
export const SHELL_RELAY_METHOD = "sf/sandbox-relay";
export const SHELL_ERROR_METHOD = "sf/sandbox-error";
export const SHELL_PROTOCOL_VERSION = 1;
export const SHELL_MESSAGE_RATE = 200;
export const TOOL_CALL_RATE = 20;
export const BINDING_UPDATED_RATE = 10;
export const MAX_TOOL_CALLS_IN_FLIGHT = 8;
export const COLLAPSED_SHELL_HEIGHT_PX = 48;
export const SANDBOX_READY_TIMEOUT_MS = 5_000;
export const MIN_FRAME_HEIGHT_PX = 200;
export const MAX_FRAME_HEIGHT_PX = 4_000;
export const HOST_BRIDGE_VERSION = "0.66.0";

export type FramePost = (message: unknown, targetOrigin: string) => void;

export type InboundMessage = {
  source: unknown;
  origin: string;
  data: unknown;
};

export type HostBridgeTimers = {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
};

const defaultTimers: HostBridgeTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms) as unknown as number,
  clear: (id) => window.clearTimeout(id),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function messageUtf8Bytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return null;
  }
}

export function clampHostFrameHeight(height: number): number | null {
  if (!Number.isFinite(height)) return null;
  return Math.min(MAX_FRAME_HEIGHT_PX, Math.max(MIN_FRAME_HEIGHT_PX, Math.round(height)));
}

function allowRate(bucket: number[], now: number, limit: number): boolean {
  const cutoff = now - 1000;
  while (bucket.length > 0 && bucket[0]! < cutoff) bucket.shift();
  if (bucket.length >= limit) return false;
  bucket.push(now);
  return true;
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type HostBridge = {
  arm: (onTimeout: () => void) => void;
  disarm: () => void;
  bind: (post: FramePost | null) => void;
  notifyBindingUpdated: (bindingId: string) => void;
  onMessage: (event: InboundMessage, frame: unknown, post: FramePost, isCurrent: () => boolean) => void;
  sentLoad: () => boolean;
};

export function createHostBridge(input: {
  sandboxOrigin: string;
  html: string;
  csp: string;
  nonce: string;
  libraries?: Array<{ name: string; version: string }>;
  allowEval?: boolean;
  readContext: () => HostContext;
  callBinding: (name: string, args: Record<string, unknown> | undefined) => Promise<ToolCallBody>;
  onHeight: (px: number) => void;
  onLinkBlocked: () => void;
  onReady: () => void;
  onSandboxError: (reason: unknown) => void;
  now?: () => number;
  timers?: HostBridgeTimers;
}): HostBridge {
  const now = input.now ?? (() => Date.now());
  const timers = input.timers ?? defaultTimers;
  let loaded = false;
  let sent = false;
  let stopped = false;
  let timer: number | null = null;
  let inflight = 0;
  let deliver: FramePost | null = null;
  const shellTimes: number[] = [];
  const toolTimes: number[] = [];
  const updateTimes = new Map<string, number[]>();
  const queuedUpdates = new Set<string>();

  function postToFrame(post: FramePost, message: unknown): void {
    post(message, input.sandboxOrigin);
  }

  function relay(post: FramePost, message: BridgeMessage): void {
    postToFrame(post, {
      jsonrpc: "2.0",
      method: SHELL_RELAY_METHOD,
      params: { nonce: input.nonce, message },
    });
  }

  function sendLoad(post: FramePost): void {
    if (sent) return;
    sent = true;
    loaded = true;
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    const libraries = input.libraries ?? [];
    postToFrame(post, {
      jsonrpc: "2.0",
      method: SHELL_LOAD_METHOD,
      params: {
        html: input.html,
        csp: input.csp,
        nonce: input.nonce,
        ...(libraries.length > 0 ? { libraries } : {}),
        ...(input.allowEval === true ? { allowEval: true } : {}),
      },
    });
    input.onReady();
    flushUpdates(post);
  }

  function sendBindingUpdated(post: FramePost, bindingId: string): void {
    const built = buildBindingUpdated(bindingId);
    if (!parseBridgeMessage(built).ok) return;
    let bucket = updateTimes.get(bindingId);
    if (!bucket) {
      bucket = [];
      updateTimes.set(bindingId, bucket);
    }
    if (!allowRate(bucket, now(), BINDING_UPDATED_RATE)) return;
    relay(post, built);
  }

  function flushUpdates(post: FramePost): void {
    for (const bindingId of queuedUpdates) sendBindingUpdated(post, bindingId);
    queuedUpdates.clear();
  }

  function bind(post: FramePost | null): void {
    deliver = post;
    if (!post || !loaded || stopped) return;
    flushUpdates(post);
  }

  function notifyBindingUpdated(bindingId: string): void {
    if (stopped) return;
    if (!deliver || !loaded) {
      queuedUpdates.add(bindingId);
      return;
    }
    sendBindingUpdated(deliver, bindingId);
  }

  function arm(onTimeout: () => void): void {
    if (timer !== null) timers.clear(timer);
    if (loaded) return;
    timer = timers.set(() => {
      timer = null;
      if (!loaded) onTimeout();
    }, SANDBOX_READY_TIMEOUT_MS);
  }

  function disarm(): void {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function onMessage(event: InboundMessage, frame: unknown, post: FramePost, isCurrent: () => boolean): void {
    if (!isCurrent()) return;
    if (frame == null || event.source !== frame) return;
    if (event.origin !== input.sandboxOrigin || event.origin === "null") return;
    if (!isRecord(event.data) || event.data.jsonrpc !== "2.0" || typeof event.data.method !== "string") return;
    if (stopped) return;
    deliver = post;
    if (event.data.method === SHELL_ERROR_METHOD) {
      stopped = true;
      disarm();
      const params = isRecord(event.data.params) ? event.data.params : null;
      input.onSandboxError(params && "reason" in params ? params.reason : undefined);
      return;
    }
    if (event.data.method === SHELL_READY_METHOD) {
      const params = event.data.params;
      if (!isRecord(params) || params.version !== SHELL_PROTOCOL_VERSION) return;
      sendLoad(post);
      return;
    }
    if (!loaded || event.data.method !== SHELL_RELAY_METHOD) return;
    const outer = messageUtf8Bytes(event.data);
    if (outer === null || outer > MAX_MESSAGE_BYTES + 256) return;
    const params = event.data.params;
    if (!isRecord(params) || params.nonce !== input.nonce) return;
    const size = messageUtf8Bytes(params.message);
    if (size === null || size > MAX_MESSAGE_BYTES) return;
    if (!allowRate(shellTimes, now(), SHELL_MESSAGE_RATE)) return;
    const parsed = parseBridgeMessage(params.message);
    if (!parsed.ok) return;
    const message = parsed.message;
    if (!("method" in message)) return;
    if (message.method === "ui/initialize" && "id" in message) {
      const context = input.readContext();
      relay(post, buildInitializeResult({
        id: message.id,
        version: HOST_BRIDGE_VERSION,
        csp: input.csp,
        hostContext: context,
      }));
      return;
    }
    if (message.method === "ping" && "id" in message) {
      relay(post, bridgeResult(message.id, {}));
      return;
    }
    if (message.method === "ui/notifications/initialized") return;
    if (message.method === "ui/notifications/size-changed") {
      const params = "params" in message && isRecord(message.params) ? message.params : null;
      const height = params && typeof params.height === "number" ? clampHostFrameHeight(params.height) : null;
      if (height !== null) input.onHeight(height);
      return;
    }
    if (message.method === "ui/notifications/link-blocked") {
      input.onLinkBlocked();
      return;
    }
    if (message.method === "tools/call" && "id" in message) {
      const id = message.id;
      const callParams = "params" in message && isRecord(message.params) ? message.params : null;
      const name = callParams && typeof callParams.name === "string" ? callParams.name : "";
      const args = callParams && isRecord(callParams.arguments) ? callParams.arguments : undefined;
      if (inflight >= MAX_TOOL_CALLS_IN_FLIGHT || !allowRate(toolTimes, now(), TOOL_CALL_RATE)) {
        relay(post, bridgeResult(id, rateLimited()));
        return;
      }
      inflight += 1;
      void input.callBinding(name, args).then((body) => {
        inflight -= 1;
        if (!isCurrent()) return;
        relay(post, bridgeResult(id, body));
      }, () => {
        inflight -= 1;
        if (!isCurrent()) return;
        relay(post, bridgeResult(id, toolFailure("query failed")));
      });
    }
  }

  return { arm, disarm, bind, notifyBindingUpdated, onMessage, sentLoad: () => sent };
}

function rateLimited(): ToolCallBody {
  return toolFailure("rate limited");
}

function toolFailure(message: string): ToolCallBody {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: null,
    isError: true,
    _meta: { source: "executed", fetched_at: new Date().toISOString() },
  };
}
