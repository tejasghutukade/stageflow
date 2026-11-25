import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  HOST_CONTEXT_VARIABLES,
  MAX_MESSAGE_BYTES,
  validateInitializeResult,
  validateToolsCallResult,
  type HostContext,
} from "../../../../../src/artifacts/bridge/protocol.ts";
import type { ArtifactLiveBinding, ArtifactSnapshot } from "../../../api/artifacts";
import { bindingCacheScope, createBindingCaller, toolError, type BindingQuery } from "./bindingCalls";
import {
  createHostBridge,
  MAX_TOOL_CALLS_IN_FLIGHT,
  SHELL_MESSAGE_RATE,
  TOOL_CALL_RATE,
  type FramePost,
  type InboundMessage,
} from "./hostBridge";
import { resetLiveQueryCacheForTests } from "../liveData/queryCache";

const ORIGIN = "http://localhost:5999";
const context: HostContext = {
  theme: "dark",
  styles: { variables: { "--sf-ground": "#111111" } },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  containerDimensions: { maxWidth: 640 },
  locale: "en-US",
  timeZone: "UTC",
  platform: "web",
};

const binding: ArtifactLiveBinding = { id: "rows", function: "revenue_by_week", args: { weeks: 12 } };

function snapshot(value: unknown, fetchedAt = "2026-11-25T00:00:00.000Z"): ArtifactSnapshot {
  return {
    binding_id: "rows",
    args_hash: "h",
    value,
    fetched_at: fetchedAt,
    duration_ms: 1,
    status: "ok",
    error_code: null,
    source: "cache",
  };
}

function bridgeOf(input: {
  html?: string;
  csp?: string;
  nonce?: string;
  callBinding?: (name: string, args: Record<string, unknown> | undefined) => Promise<ReturnType<typeof toolError>>;
  now?: () => number;
}) {
  const post = vi.fn<FramePost>();
  const frame = {};
  const onHeight = vi.fn();
  const onLinkBlocked = vi.fn();
  const onReady = vi.fn();
  const onSandboxError = vi.fn();
  const timeouts: Array<() => void> = [];
  const bridge = createHostBridge({
    sandboxOrigin: ORIGIN,
    html: input.html ?? "<p>Hi</p>",
    csp: input.csp ?? "default-src 'none'",
    nonce: input.nonce ?? "ab".repeat(16),
    readContext: () => context,
    callBinding: input.callBinding ?? (async () => toolError("missing")),
    onHeight,
    onLinkBlocked,
    onReady,
    onSandboxError,
    now: input.now ?? (() => 1_000),
    timers: {
      set: (fn) => {
        timeouts.push(fn);
        return timeouts.length;
      },
      clear: () => undefined,
    },
  });
  const current = { value: true };
  function send(data: unknown, patch: Partial<InboundMessage> = {}) {
    bridge.onMessage({
      source: frame,
      origin: ORIGIN,
      data,
      ...patch,
    }, frame, post, () => current.value);
  }
  return { bridge, post, frame, onHeight, onLinkBlocked, onReady, onSandboxError, timeouts, send, current };
}

function relay(message: unknown, nonce = "ab".repeat(16)) {
  return { jsonrpc: "2.0", method: "sf/sandbox-relay", params: { nonce, message } };
}

function loads(post: ReturnType<typeof vi.fn>) {
  return post.mock.calls
    .map((call) => call[0] as { method?: string; params?: { html?: string; csp?: string; nonce?: string } })
    .filter((message) => message.method === "sf/sandbox-load");
}

function replies(post: ReturnType<typeof vi.fn>) {
  return post.mock.calls
    .map((call) => call[0] as { method?: string; params?: { message?: { result?: unknown; id?: unknown } } })
    .filter((message) => message.method === "sf/sandbox-relay")
    .map((message) => message.params?.message);
}

describe("host bridge", () => {
  it("sends one load after a matching ready and ignores the rest", () => {
    const harness = bridgeOf({});
    harness.bridge.arm(() => undefined);
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } }, { source: {} });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } }, { origin: "null" });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } }, { origin: "http://evil.example" });
    const sent = loads(harness.post);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({ html: "<p>Hi</p>", csp: "default-src 'none'", nonce: "ab".repeat(16) });
    expect(harness.post.mock.calls.every((call) => call[1] === ORIGIN)).toBe(true);
    expect(harness.post.mock.calls.some((call) => call[1] === "*")).toBe(false);
    expect(harness.onReady).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent[0])).not.toMatch(/token|Bearer|\/api\//);
  });

  it("drops the wrong nonce, oversize, malformed, and unknown methods", () => {
    const harness = bridgeOf({});
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    harness.send(relay({ jsonrpc: "2.0", id: 1, method: "ping" }, "00".repeat(16)));
    harness.send(relay({ jsonrpc: "2.0", method: "ping" }));
    harness.send(relay({ jsonrpc: "2.0", id: 1, method: "nope" }));
    harness.send(relay({
      jsonrpc: "2.0",
      method: "ui/notifications/link-blocked",
      params: { href: "x".repeat(MAX_MESSAGE_BYTES) },
    }));
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-relay", params: { message: { jsonrpc: "2.0", id: 1, method: "ping" } } });
    expect(harness.post).not.toHaveBeenCalled();
  });

  it("answers initialize, ping, size, and link-blocked", () => {
    const harness = bridgeOf({});
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    harness.send(relay({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/initialize",
      params: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        appInfo: { name: "live-html", version: "1" },
        appCapabilities: { availableDisplayModes: ["inline"] },
      },
    }));
    harness.send(relay({ jsonrpc: "2.0", id: 8, method: "ping" }));
    harness.send(relay({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }));
    harness.send(relay({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 50, width: 10 } }));
    harness.send(relay({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 4000 } }));
    harness.send(relay({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } }));
    harness.send(relay({ jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "https://example.com/out" } }));
    const answered = replies(harness.post);
    const init = answered.find((message) => message && "id" in message && message.id === 7);
    expect(init && "result" in init && validateInitializeResult(init.result)).toBe(true);
    const initResult = (init as { result: { hostContext: HostContext; hostCapabilities: { sandbox: { csp: string } } } }).result;
    expect(Object.keys(initResult.hostContext.styles.variables)).toEqual(["--sf-ground"]);
    for (const name of Object.keys(initResult.hostContext.styles.variables)) {
      expect(HOST_CONTEXT_VARIABLES).toContain(name);
    }
    expect(initResult.hostCapabilities.sandbox.csp).toBe("default-src 'none'");
    expect(JSON.stringify(initResult)).not.toMatch(/token|Bearer|authorization/i);
    expect(answered.find((message) => message && "id" in message && message.id === 8)).toMatchObject({ result: {} });
    expect(harness.onHeight.mock.calls.map((call) => call[0])).toEqual([200, 4000]);
    expect(harness.onLinkBlocked).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.post.mock.calls)).not.toContain("https://example.com/out");
  });

  it("rate limits shell traffic and tools/call", async () => {
    let clock = 5_000;
    let hold = true;
    const releases: Array<(value: ReturnType<typeof toolError>) => void> = [];
    const harness = bridgeOf({
      now: () => clock,
      callBinding: () => {
        if (!hold) return Promise.resolve(toolError("done"));
        return new Promise((resolve) => {
          releases.push(resolve);
        });
      },
    });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    for (let i = 0; i < SHELL_MESSAGE_RATE + 1; i += 1) {
      harness.send(relay({ jsonrpc: "2.0", id: i, method: "ping" }));
    }
    expect(replies(harness.post)).toHaveLength(SHELL_MESSAGE_RATE);
    clock += 2_000;
    harness.post.mockClear();
    const pending = MAX_TOOL_CALLS_IN_FLIGHT + 1;
    for (let i = 0; i < pending; i += 1) {
      harness.send(relay({ jsonrpc: "2.0", id: `t${i}`, method: "tools/call", params: { name: "rows" } }));
    }
    expect(releases).toHaveLength(MAX_TOOL_CALLS_IN_FLIGHT);
    expect(replies(harness.post).some((message) => JSON.stringify(message).includes("rate limited"))).toBe(true);
    hold = false;
    for (const resolve of releases) resolve(toolError("done"));
    await vi.waitFor(() => expect(replies(harness.post).length).toBe(pending));
    clock += 2_000;
    harness.post.mockClear();
    for (let i = 0; i < TOOL_CALL_RATE + 1; i += 1) {
      harness.send(relay({ jsonrpc: "2.0", id: `r${i}`, method: "tools/call", params: { name: "rows" } }));
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(replies(harness.post).length).toBe(TOOL_CALL_RATE + 1));
    const bodies = replies(harness.post).map((message) => JSON.stringify(message));
    expect(bodies.filter((body) => body.includes("rate limited"))).toHaveLength(1);
  });

  it("stops replying after the caller is no longer current", async () => {
    const pendingResolve: { current: ((value: ReturnType<typeof toolError>) => void) | null } = { current: null };
    const harness = bridgeOf({
      callBinding: () => new Promise((resolve) => {
        pendingResolve.current = resolve;
      }),
    });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    harness.send(relay({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rows" } }));
    harness.current.value = false;
    pendingResolve.current?.(toolError("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.post).not.toHaveBeenCalled();
  });

  it("ignores unknown shell messages and stops after a sandbox error", () => {
    const harness = bridgeOf({});
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-unknown", params: { reason: "navigated" } });
    harness.send({ jsonrpc: "2.0", method: "sf/not-a-shell" });
    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.onSandboxError).not.toHaveBeenCalled();
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason: "navigated" } });
    expect(harness.onSandboxError).toHaveBeenCalledWith("navigated");
    harness.post.mockClear();
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.send(relay({ jsonrpc: "2.0", id: 1, method: "ping" }));
    harness.bridge.notifyBindingUpdated("rows");
    expect(harness.post).not.toHaveBeenCalled();
  });

  it("relays a binding update at most ten times a second per binding", () => {
    let clock = 8_000;
    const harness = bridgeOf({ now: () => clock });
    harness.send({ jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } });
    harness.post.mockClear();
    for (let i = 0; i < 11; i += 1) harness.bridge.notifyBindingUpdated("rows");
    harness.bridge.notifyBindingUpdated("other");
    harness.bridge.notifyBindingUpdated("Not Valid");
    const updates = harness.post.mock.calls
      .map((call) => call[0] as { method?: string; params?: { nonce?: string; message?: { method?: string; params?: { binding_id?: string } } } })
      .filter((message) => message.params?.message?.method === "ui/notifications/binding-updated");
    expect(updates.filter((message) => message.params?.message?.params?.binding_id === "rows")).toHaveLength(10);
    expect(updates.filter((message) => message.params?.message?.params?.binding_id === "other")).toHaveLength(1);
    expect(updates.every((message) => message.method === "sf/sandbox-relay" && message.params?.nonce === "ab".repeat(16))).toBe(true);
    expect(harness.post.mock.calls.every((call) => call[1] === ORIGIN)).toBe(true);
    clock += 1_001;
    harness.bridge.notifyBindingUpdated("rows");
    const after = harness.post.mock.calls
      .map((call) => call[0] as { params?: { message?: { params?: { binding_id?: string } } } })
      .filter((message) => message.params?.message?.params?.binding_id === "rows");
    expect(after).toHaveLength(11);
  });
});

describe("binding calls", () => {
  const scope = "stage:sales:summarize/weekly";

  function caller(input: {
    snapshots?: ArtifactSnapshot[];
    pending?: boolean;
    historical?: boolean;
    query?: BindingQuery;
    bindings?: ArtifactLiveBinding[];
    wait?: (bindingId: string) => Promise<void>;
    aborted?: () => boolean;
    cacheScope?: string;
  }) {
    let snapshots = input.snapshots ?? [];
    let pending = input.pending ?? false;
    return {
      setSnapshots(next: ArtifactSnapshot[]) {
        snapshots = next;
      },
      setPending(next: boolean) {
        pending = next;
      },
      call: createBindingCaller({
        bindings: input.bindings ?? [binding],
        getSnapshots: () => snapshots,
        pending: () => pending,
        aborted: input.aborted,
        historical: input.historical ?? false,
        waitForSnapshot: async (bindingId) => {
          if (input.wait) await input.wait(bindingId);
        },
        query: input.query ?? (async () => ({ status: 500, body: null })),
        cacheScope: input.cacheScope ?? scope,
      }),
    };
  }

  it("covers unknown, default, waiting, variant, and limits of the shared cache", async () => {
    resetLiveQueryCacheForTests();
    const query = vi.fn<BindingQuery>();
    const harness = caller({ snapshots: [], pending: true, query, wait: async () => undefined });
    await expect(harness.call("missing", undefined)).resolves.toMatchObject({ isError: true, content: [{ text: "unknown binding" }] });
    const release: { current: (() => void) | null } = { current: null };
    const waiting = caller({
      snapshots: [],
      pending: true,
      query,
      wait: () => new Promise((resolve) => {
        release.current = () => resolve();
      }),
    });
    const pending = waiting.call("rows", undefined);
    waiting.setSnapshots([snapshot({ weeks: 12 })]);
    release.current?.();
    const ready = await pending;
    expect(ready.isError).toBeUndefined();
    expect(ready.structuredContent).toEqual({ weeks: 12 });
    expect(validateToolsCallResult(ready)).toBe(true);
    expect(query).not.toHaveBeenCalled();

    const empty = caller({ snapshots: [], pending: false, query });
    await expect(empty.call("rows", { weeks: 12 })).resolves.toMatchObject({
      isError: true,
      content: [{ text: "no data yet" }],
      _meta: { retryable: true },
    });
    expect(validateToolsCallResult(await empty.call("rows", undefined))).toBe(true);

    const historical = caller({ snapshots: [snapshot({ weeks: 12 })], historical: true, query });
    await expect(historical.call("rows", undefined)).resolves.toMatchObject({ isError: true, content: [{ text: "no data for this version" }] });

    query.mockResolvedValue({
      status: 200,
      body: {
        binding_id: "rows",
        args_hash: "v",
        snapshot: { ...snapshot({ weeks: 4 }, "2026-11-25T01:00:00.000Z"), source: "executed" },
        errors: [],
      },
    });
    const variant = caller({ snapshots: [snapshot({ weeks: 12 })], query });
    const first = variant.call("rows", { weeks: 4 });
    const second = variant.call("rows", { weeks: 4 });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.structuredContent).toEqual({ weeks: 4 });
    expect(a._meta).toEqual({ source: "executed", fetched_at: "2026-11-25T01:00:00.000Z" });
    expect(query).toHaveBeenCalledTimes(1);
    await variant.call("rows", { weeks: 4 });
    expect(query).toHaveBeenCalledTimes(1);

    query.mockResolvedValueOnce({ status: 503, body: { error: "busy", retry_after_seconds: 3 } });
    const busy = await variant.call("rows", { weeks: 1 });
    expect(busy).toMatchObject({ isError: true, content: [{ text: "the server is busy" }], _meta: { retry_after_seconds: 3 } });
    query.mockResolvedValueOnce({ status: 400, body: { code: "artifact.binding_args_invalid" } });
    await expect(variant.call("rows", { weeks: 2 })).resolves.toMatchObject({ isError: true, content: [{ text: "artifact.binding_args_invalid" }] });
    query.mockResolvedValueOnce({ status: 0, body: null, networkError: "offline" });
    await expect(variant.call("rows", { weeks: 3 })).resolves.toMatchObject({ isError: true, content: [{ text: "network error" }] });
  });

  it("waits for a default snapshot while a refresh is in flight and reports retryable when it fails", async () => {
    const release: { current: (() => void) | null } = { current: null };
    const waiting = caller({
      snapshots: [],
      pending: true,
      wait: () => new Promise((resolve) => {
        release.current = () => resolve();
      }),
    });
    const pending = waiting.call("rows", { weeks: 12 });
    waiting.setSnapshots([snapshot({ weeks: 8 })]);
    waiting.setPending(false);
    release.current?.();
    await expect(pending).resolves.toMatchObject({ structuredContent: { weeks: 8 } });

    let aborted = false;
    const dropped = caller({
      snapshots: [],
      pending: true,
      aborted: () => aborted,
      wait: () => new Promise((resolve) => {
        aborted = true;
        resolve();
      }),
    });
    await expect(dropped.call("rows", undefined)).resolves.toMatchObject({ isError: true, _meta: { retryable: true } });

    const failed = caller({ snapshots: [], pending: false });
    const body = await failed.call("rows", undefined);
    expect(body).toMatchObject({ isError: true, content: [{ text: "no data yet" }], _meta: { retryable: true } });
    expect(validateToolsCallResult(body)).toBe(true);
  });

  it("does not share variant results across projects or versions", async () => {
    resetLiveQueryCacheForTests();
    const query = vi.fn<BindingQuery>(async () => ({
      status: 200,
      body: {
        binding_id: "rows",
        args_hash: "v",
        snapshot: { ...snapshot({ weeks: 4 }), source: "executed" },
        errors: [],
      },
    }));
    const left = caller({
      snapshots: [snapshot({ weeks: 12 })],
      query,
      cacheScope: bindingCacheScope("/projects/left", "stage:sales:summarize", "weekly", 2),
    });
    const right = caller({
      snapshots: [snapshot({ weeks: 12 })],
      query,
      cacheScope: bindingCacheScope("/projects/right", "stage:sales:summarize", "weekly", 2),
    });
    await left.call("rows", { weeks: 4 });
    await right.call("rows", { weeks: 4 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(bindingCacheScope("/projects/left", "stage:sales:summarize", "weekly", 2)).not.toBe(
      bindingCacheScope("/projects/right", "stage:sales:summarize", "weekly", 2),
    );
    expect(bindingCacheScope("/projects/left", "stage:sales:summarize", "weekly", 2)).not.toBe(
      bindingCacheScope("/projects/left", "stage:sales:summarize", "weekly", 3),
    );
    expect(bindingCacheScope(undefined, "stage:sales:summarize", "weekly", 2)).toBe(`\0stage:sales:summarize\0weekly\0${2}`);
  });
});
