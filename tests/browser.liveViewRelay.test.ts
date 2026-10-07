import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRunner } from "../src/browser/browserHost.js";
import {
  createAgentBrowserLiveViewRelay,
  LiveViewRelayError,
} from "../src/browser/agentBrowserLiveViewRelay.js";
import { createFakeLiveViewRelay } from "../src/browser/fakeLiveViewRelay.js";
import type {
  LiveViewMessage,
  LiveViewRelay,
  LiveViewSession,
} from "../src/browser/liveViewRelay.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type FakeStreamServer = {
  port: number;
  received: string[];
  emit(message: unknown): void;
  dropClients(): void;
  clientCount(): number;
  close(): Promise<void>;
};

function encodeText(text: string): Buffer {
  const payload = Buffer.from(text);
  const n = payload.length;
  const header =
    n < 126
      ? Buffer.from([0x81, n])
      : n < 65536
        ? Buffer.from([0x81, 126, n >> 8, n & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(n), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): { texts: string[]; rest: Buffer; closed: boolean } {
  const texts: string[] = [];
  let closed = false;
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    const masked = (buffer[offset + 1]! & 0x80) !== 0;
    let length = buffer[offset + 1]! & 0x7f;
    let pos = offset + 2;
    if (length === 126) {
      if (buffer.length - pos < 2) break;
      length = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (buffer.length - pos < 8) break;
      length = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buffer.length - pos < maskLen + length) break;
    const mask = masked ? buffer.subarray(pos, pos + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(pos + maskLen, pos + maskLen + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    if (opcode === 1) texts.push(payload.toString("utf8"));
    if (opcode === 8) closed = true;
    offset = pos + maskLen + length;
  }
  return { texts, rest: buffer.subarray(offset), closed };
}

async function startFakeStreamServer(): Promise<FakeStreamServer> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket: Socket) => {
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const out = decodeFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(out.rest);
      received.push(...out.texts);
      if (out.closed) socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received,
    emit(message) {
      const frame = encodeText(typeof message === "string" ? message : JSON.stringify(message));
      for (const socket of sockets) socket.write(frame);
    },
    dropClients() {
      for (const socket of sockets) socket.destroy();
    },
    clientCount: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function until(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 40));

const request = { runId: "r1", stageId: "s1", env: { AGENT_BROWSER_SESSION: "s" } };

function statusRunner(port: number, calls: string[][] = []): BrowserRunner {
  return async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ success: true, data: { enabled: true, port } }) };
  };
}

type Harness = {
  session: LiveViewSession;
  emit(message: LiveViewMessage): Promise<void>;
  input(): string[];
  dropUpstream(): void;
};

type Factory = () => Promise<Harness>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const fakeFactory: Factory = async () => {
  const relay = createFakeLiveViewRelay();
  const session = await relay.open(request);
  const fake = relay.sessions[0]!;
  return {
    session,
    async emit(message) {
      fake.emit(message);
    },
    input: () => fake.input.map((e) => JSON.stringify(e)),
    dropUpstream: () => {},
  };
};

const realFactory: Factory = async () => {
  const server = await startFakeStreamServer();
  const relay = createAgentBrowserLiveViewRelay({ runner: statusRunner(server.port) });
  const session = await relay.open(request);
  cleanups.push(async () => {
    await session.close();
    await server.close();
  });
  return {
    session,
    async emit(message) {
      server.emit({ type: message.type, ...(message.data as object) });
      await settle();
    },
    input: () => server.received,
    dropUpstream: () => server.dropClients(),
  };
};

const click = { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 };
const key = (text: string) => ({ type: "input_keyboard", eventType: "keyDown", key: text, text });

function contract(name: string, factory: Factory) {
  describe(`live view relay contract: ${name}`, () => {
    it("a late joiner gets status/tabs/url then the last frame with no new upstream frame", async () => {
      const h = await factory();
      await h.emit({ type: "frame", data: { data: "f1" } });
      await h.emit({ type: "status", data: { connected: true } });
      await h.emit({ type: "tabs", data: { tabs: [] } });
      await h.emit({ type: "url", data: { url: "https://a" } });
      await h.emit({ type: "frame", data: { data: "f2" } });
      const got: LiveViewMessage[] = [];
      h.session.subscribe((m) => got.push(m));
      expect(got.map((m) => m.type)).toEqual(["status", "tabs", "url", "frame"]);
      expect(got.at(-1)?.data).toEqual({ data: "f2" });
    });

    it("clearFrame stops the frame replay but keeps the rest", async () => {
      const h = await factory();
      await h.emit({ type: "frame", data: { data: "f1" } });
      await h.emit({ type: "url", data: { url: "u" } });
      h.session.clearFrame();
      const got: LiveViewMessage[] = [];
      h.session.subscribe((m) => got.push(m));
      expect(got.map((m) => m.type)).toEqual(["url"]);
    });

    it("two subscribers both get frames; unsubscribe stops delivery", async () => {
      const h = await factory();
      const a: string[] = [];
      const b: string[] = [];
      const offA = h.session.subscribe((m) => a.push(m.type));
      h.session.subscribe((m) => b.push(m.type));
      await h.emit({ type: "frame", data: { data: "x" } });
      offA();
      await h.emit({ type: "frame", data: { data: "y" } });
      expect(a).toEqual(["frame"]);
      expect(b).toEqual(["frame", "frame"]);
    });

    it("input keeps order across batches", async () => {
      const h = await factory();
      expect(await h.session.sendInput([click, key("a")])).toEqual({ ok: true, accepted: 2 });
      await h.session.sendInput([key("b")]);
      await until(() => h.input().length === 3, "upstream input");
      expect(h.input().map((t) => (JSON.parse(t) as { type: string; key?: string }).key ?? "click")).toEqual([
        "click",
        "a",
        "b",
      ]);
    });

    it("close is idempotent, notifies subscribers, and rejects later input", async () => {
      const h = await factory();
      const got: LiveViewMessage[] = [];
      h.session.subscribe((m) => got.push(m));
      await h.session.close();
      await h.session.close();
      expect(got.filter((m) => m.type === "closed")).toHaveLength(1);
      expect(await h.session.sendInput([click])).toEqual({ ok: false, reason: "closed" });
    });
  });
}

contract("fake relay", fakeFactory);
contract("agent-browser relay on a fake stream server", realFactory);

describe("agent-browser live view relay", () => {
  it("drops non-forwarded upstream messages", async () => {
    const server = await startFakeStreamServer();
    const relay = createAgentBrowserLiveViewRelay({ runner: statusRunner(server.port) });
    const session = await relay.open(request);
    cleanups.push(async () => {
      await session.close();
      await server.close();
    });
    const got: LiveViewMessage[] = [];
    session.subscribe((m) => got.push(m));
    server.emit({ type: "console", text: "page secret" });
    server.emit({ type: "command", command: "navigate" });
    server.emit({ type: "launch", x: 1 });
    server.emit({ type: "mystery" });
    server.emit("not json");
    server.emit({ type: "frame", data: "AAAA", metadata: { width: 1 } });
    await until(() => got.length > 0, "frame");
    await settle();
    expect(got).toEqual([{ type: "frame", data: { data: "AAAA", metadata: { width: 1 } } }]);
  });

  describe("input validation", () => {
    async function open(extra: { maxBatch?: number; maxEventsPerSecond?: number; now?: () => number } = {}) {
      const server = await startFakeStreamServer();
      const relay = createAgentBrowserLiveViewRelay({ runner: statusRunner(server.port), ...extra });
      const session = await relay.open(request);
      cleanups.push(async () => {
        await session.close();
        await server.close();
      });
      return { server, session };
    }

    const bad: Array<[string, unknown]> = [
      ["non-object", "boom"],
      ["null", null],
      ["array event", [click]],
      ["unknown type", { type: "input_exec", cmd: "x" }],
      ["missing type", { eventType: "mousePressed", x: 1, y: 1 }],
      ["forged extra field", { ...click, forged: true }],
      ["bad mouse eventType", { ...click, eventType: "drag" }],
      ["NaN x", { ...click, x: Number.NaN }],
      ["infinite y", { ...click, y: Infinity }],
      ["huge x", { ...click, x: 1e9 }],
      ["negative x", { ...click, x: -1 }],
      ["string x", { ...click, x: "1" }],
      ["bad button", { ...click, button: "back" }],
      ["clickCount 4", { ...click, clickCount: 4 }],
      ["fractional clickCount", { ...click, clickCount: 1.5 }],
      ["infinite deltaY", { type: "input_mouse", eventType: "mouseWheel", x: 1, y: 1, deltaY: Infinity }],
      ["bad keyboard eventType", { type: "input_keyboard", eventType: "press" }],
      ["long key", { type: "input_keyboard", eventType: "keyDown", key: "k".repeat(33) }],
      ["numeric text", { type: "input_keyboard", eventType: "char", text: 5 }],
      ["vk 256", { type: "input_keyboard", eventType: "keyDown", windowsVirtualKeyCode: 256 }],
      ["modifiers 16", { type: "input_keyboard", eventType: "keyDown", modifiers: 16 }],
      ["bad touch eventType", { type: "input_touch", eventType: "tap", touchPoints: [] }],
      ["touch without points", { type: "input_touch", eventType: "touchStart" }],
      ["too many touch points", { type: "input_touch", eventType: "touchStart", touchPoints: Array.from({ length: 11 }, () => ({ x: 1, y: 1 })) }],
      ["forged touch point field", { type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 1, y: 1, evil: 1 }] }],
    ];

    it.each(bad)("rejects %s and forwards nothing", async (_name, event) => {
      const { server, session } = await open();
      const result = await session.sendInput([click, event as never]);
      expect(result).toEqual({ ok: false, reason: "invalid_event" });
      await settle();
      expect(server.received).toEqual([]);
    });

    it("accepts valid mouse, keyboard and touch shapes", async () => {
      const { server, session } = await open();
      const events = [
        click,
        { type: "input_mouse", eventType: "mouseWheel", x: 5.5, y: 6, deltaX: 0, deltaY: -120 },
        { type: "input_keyboard", eventType: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 },
        { type: "input_keyboard", eventType: "char", text: "é" },
        { type: "input_touch", eventType: "touchStart", touchPoints: [{ x: 1, y: 2, id: 0 }] },
        { type: "input_touch", eventType: "touchEnd", touchPoints: [] },
      ];
      expect(await session.sendInput(events)).toEqual({ ok: true, accepted: 6 });
      await until(() => server.received.length === 6, "input");
      expect(server.received.map((t) => JSON.parse(t))).toEqual(events);
    });

    it("rejects non-array batches and oversized batches", async () => {
      const { server, session } = await open({ maxBatch: 3 });
      expect(await session.sendInput({ length: 1 } as never)).toEqual({ ok: false, reason: "not_array" });
      expect(await session.sendInput([click, click, click, click])).toEqual({
        ok: false,
        reason: "batch_too_large",
      });
      await settle();
      expect(server.received).toEqual([]);
      expect(await session.sendInput([click, click, click])).toEqual({ ok: true, accepted: 3 });
    });

    it("rate limits per second with an injectable clock", async () => {
      let t = 1_000;
      const { server, session } = await open({ maxEventsPerSecond: 5, now: () => t });
      expect(await session.sendInput([click, click, click])).toEqual({ ok: true, accepted: 3 });
      expect(await session.sendInput([click, click, click])).toEqual({ ok: false, reason: "rate_limited" });
      expect(await session.sendInput([click, click])).toEqual({ ok: true, accepted: 2 });
      expect(await session.sendInput([click])).toEqual({ ok: false, reason: "rate_limited" });
      t += 1000;
      expect(await session.sendInput([click])).toEqual({ ok: true, accepted: 1 });
      await until(() => server.received.length === 6, "input");
    });
  });

  describe("stream port discovery", () => {
    it("reads the port once, with the stage env untouched, and never calls again", async () => {
      const server = await startFakeStreamServer();
      const calls: string[][] = [];
      const envs: unknown[] = [];
      const env = { AGENT_BROWSER_SESSION: "s", AGENT_BROWSER_CDP: "ws://x" };
      const frozen = JSON.stringify(env);
      const runner: BrowserRunner = async (args, e) => {
        envs.push(e);
        return statusRunner(server.port, calls)(args, e);
      };
      const relay = createAgentBrowserLiveViewRelay({ runner });
      const session = await relay.open({ ...request, env });
      cleanups.push(async () => {
        await session.close();
        await server.close();
      });
      const got: LiveViewMessage[] = [];
      for (let i = 0; i < 3; i++) {
        const off = session.subscribe((m) => got.push(m));
        server.emit({ type: "frame", data: `f${i}` });
        server.emit({ type: "status", connected: true });
        await settle();
        await session.sendInput([click]);
        off();
      }
      await settle();
      expect(calls).toEqual([["stream", "status", "--json"]]);
      expect(envs[0]).toBe(env);
      expect(JSON.stringify(env)).toBe(frozen);
      expect(Object.keys(env).some((k) => k.includes("STREAM"))).toBe(false);
    });

    it("enables streaming once when status says it is off, then reads again", async () => {
      const server = await startFakeStreamServer();
      const calls: string[][] = [];
      let enabled = false;
      const runner: BrowserRunner = async (args) => {
        calls.push(args);
        if (args[1] === "enable") {
          enabled = true;
          return { code: 0, stdout: "{}" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ data: enabled ? { enabled: true, port: server.port } : { enabled: false } }),
        };
      };
      const session = await createAgentBrowserLiveViewRelay({ runner }).open({
        ...request,
        cdpAddress: "ws://127.0.0.1:1",
      });
      cleanups.push(async () => {
        await session.close();
        await server.close();
      });
      expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
        "stream status",
        "stream enable",
        "stream status",
      ]);
    });

    it.each([
      ["non-zero exit", { code: 1, stdout: "" }],
      ["bad json", { code: 0, stdout: "not json" }],
      ["missing port", { code: 0, stdout: JSON.stringify({ data: { enabled: true } }) }],
      ["bad port", { code: 0, stdout: JSON.stringify({ data: { port: "9" } }) }],
    ])("fails with a typed error: %s", async (_name, result) => {
      const calls: string[][] = [];
      const runner: BrowserRunner = async (args) => {
        calls.push(args);
        return result;
      };
      const err = await createAgentBrowserLiveViewRelay({ runner })
        .open(request)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LiveViewRelayError);
      expect((err as LiveViewRelayError).code).toBe("stream_port_unavailable");
      expect(calls).toHaveLength(3);
    });

    it("fails with a typed error when the stream refuses connections, without leaking payloads", async () => {
      const server = await startFakeStreamServer();
      const port = server.port;
      await server.close();
      const err = await createAgentBrowserLiveViewRelay({ runner: statusRunner(port) })
        .open(request)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LiveViewRelayError);
      expect((err as LiveViewRelayError).code).toBe("stream_connect_failed");
    });
  });

  it("an upstream drop notifies subscribers with a reason and rejects input", async () => {
    const server = await startFakeStreamServer();
    const session = await createAgentBrowserLiveViewRelay({ runner: statusRunner(server.port) }).open(request);
    cleanups.push(async () => {
      await session.close();
      await server.close();
    });
    const got: LiveViewMessage[] = [];
    session.subscribe((m) => got.push(m));
    server.dropClients();
    await until(() => got.length > 0, "closed message");
    expect(got).toEqual([{ type: "closed", data: { reason: "upstream_closed" } }]);
    expect(await session.sendInput([click])).toEqual({ ok: false, reason: "closed" });
    const late: LiveViewMessage[] = [];
    session.subscribe((m) => late.push(m));
    expect(late.map((m) => m.type)).toEqual(["closed"]);
  });

  it("errors never carry input or frame payloads", async () => {
    const server = await startFakeStreamServer();
    const port = server.port;
    await server.close();
    const secret = "hunter2-secret";
    const runner: BrowserRunner = async () => ({ code: 0, stdout: JSON.stringify({ data: { port, secret } }) });
    const err = (await createAgentBrowserLiveViewRelay({ runner })
      .open(request)
      .catch((e: unknown) => e)) as Error;
    expect(`${err.message} ${err.stack ?? ""}`).not.toContain(secret);
  });

  it("close with no subscribers tears the stream client down and is idempotent", async () => {
    const server = await startFakeStreamServer();
    const session = await createAgentBrowserLiveViewRelay({ runner: statusRunner(server.port) }).open(request);
    cleanups.push(() => server.close());
    await session.close();
    await session.close();
    await settle();
    expect(await session.sendInput([click])).toEqual({ ok: false, reason: "closed" });
  });
});

type Tab = { tabId: string; targetId: string; url: string };

async function setupRelay(
  options: {
    retryDelayMs?: number;
    env?: Record<string, string>;
    cdpAddress?: string | null;
    dialogTimeoutMs?: number;
  } = {},
) {
  const stream = await startFakeStreamServer();
  const cdp = await startFakeStreamServer();
  const calls: string[][] = [];
  const tabs: Tab[] = [];
  const hooks: {
    failTab: boolean;
    gate?: (args: string[]) => Promise<void> | undefined;
  } = { failTab: false };
  const runner: BrowserRunner = async (args) => {
    calls.push(args);
    await hooks.gate?.(args);
    const cmd = args.slice(0, 2).join(" ");
    if (cmd === "stream status") {
      return { code: 0, stdout: JSON.stringify({ success: true, data: { enabled: true, port: stream.port } }) };
    }
    if (cmd === "get cdp-url") return { code: 0, stdout: `ws://127.0.0.1:${cdp.port}\n` };
    if (args[0] === "tab" && args[1] === "--json") {
      const listed = tabs.map((t, i) => ({ active: i === 0, title: "", type: "page", ...t }));
      return { code: 0, stdout: JSON.stringify({ success: true, data: { tabs: listed } }) };
    }
    if (args[0] === "tab" && hooks.failTab) return { code: 1, stdout: "" };
    return { code: 0, stdout: "{}" };
  };
  const pendingTimers = new Set<() => void>();
  const timerMs = new Map<() => void, number>();
  const schedule = (fn: () => void, ms: number) => {
    const entry = () => {
      pendingTimers.delete(entry);
      fn();
    };
    pendingTimers.add(entry);
    timerMs.set(entry, ms);
    return () => void pendingTimers.delete(entry);
  };
  const relay = createAgentBrowserLiveViewRelay({
    runner,
    retryDelayMs: options.retryDelayMs ?? 5,
    schedule,
    ...(options.dialogTimeoutMs === undefined ? {} : { dialogTimeoutMs: options.dialogTimeoutMs }),
  });
  const cdpAddress = options.cdpAddress === null ? undefined : (options.cdpAddress ?? `ws://127.0.0.1:${cdp.port}`);
  const session = await relay.open({
    ...request,
    env: options.env ?? request.env,
    ...(cdpAddress === undefined ? {} : { cdpAddress }),
  });
  cleanups.push(async () => {
    await session.close();
    await stream.close();
    await cdp.close();
  });
  const got: LiveViewMessage[] = [];
  session.subscribe((m) => got.push(m));
  const page = (targetId: string, url: string, openerId?: string, type = "page") => ({
    targetInfo: { targetId, type, url, ...(openerId === undefined ? {} : { openerId }) },
  });
  return {
    stream,
    cdp,
    pendingTimers,
    fireTimersWithMs: (ms: number) => [...pendingTimers].filter((f) => timerMs.get(f) === ms).forEach((fire) => fire()),
    timersWithMs: (ms: number) => [...pendingTimers].filter((f) => timerMs.get(f) === ms).length,
    fireTimers: () => [...pendingTimers].forEach((fire) => fire()),
    calls,
    tabs,
    hooks,
    session,
    got,
    created: (...args: Parameters<typeof page>) =>
      cdp.emit({ method: "Target.targetCreated", params: page(...args) }),
    changed: (...args: Parameters<typeof page>) =>
      cdp.emit({ method: "Target.targetInfoChanged", params: page(...args) }),
    destroyed: (targetId: string) =>
      cdp.emit({ method: "Target.targetDestroyed", params: { targetId } }),
    retargets: () => got.filter((m) => m.type === "retarget").map((m) => m.data),
  };
}


describe("agent-browser live view relay: popup re-targeting", () => {
  const setup = setupRelay;

  it("subscribes to target discovery on its own CDP connection", async () => {
    const h = await setup();
    await until(() => h.cdp.received.length > 0, "discover");
    expect(JSON.parse(h.cdp.received[0]!)).toMatchObject({
      method: "Target.setDiscoverTargets",
      params: { discover: true },
    });
  });

  it("publishes the current page address from target discovery, including before any navigation", async () => {
    const h = await setup();
    h.created("o1", "http://a/login");
    await until(() => h.got.some((m) => m.type === "url"), "initial url");
    h.changed("o1", "http://a/home");
    await until(() => h.got.filter((m) => m.type === "url").length === 2, "navigation url");
    h.changed("o1", "http://a/home");
    h.created("x", "http://other/");
    await new Promise((r) => setTimeout(r, 30));
    expect(h.got.filter((m) => m.type === "url").map((m) => m.data)).toEqual([
      { url: "http://a/login" },
      { url: "http://a/home" },
    ]);
    const late: LiveViewMessage[] = [];
    h.session.subscribe((m) => late.push(m));
    expect(late.find((m) => m.type === "url")?.data).toEqual({ url: "http://a/home" });
  });

  it("re-targets to a popup with the exact command sequence and tells subscribers", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.created("p1", "", "o1");
    await until(() => h.retargets().length === 1, "retarget");
    expect(h.calls).toEqual([
      ["stream", "status", "--json"],
      ["tab", "--json"],
      ["tab", "t2"],
      ["stream", "disable"],
      ["stream", "enable", "--port", String(h.stream.port)],
    ]);
    expect(h.retargets()).toEqual([{ tab: "t2", url: "http://a/p", reason: "popup_opened" }]);
  });

  it("clears the frame cache so a late joiner gets the new tab's frame", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.stream.emit({ type: "frame", data: "old" });
    await settle();
    h.created("p1", "http://a/p", "o1");
    await until(() => h.retargets().length === 1, "retarget");
    const early: LiveViewMessage[] = [];
    h.session.subscribe((m) => early.push(m));
    expect(early.filter((m) => m.type === "frame")).toEqual([]);
    h.stream.emit({ type: "frame", data: "new" });
    await settle();
    const late: LiveViewMessage[] = [];
    h.session.subscribe((m) => late.push(m));
    expect(late.filter((m) => m.type === "frame").map((m) => m.data)).toEqual([{ data: "new" }]);
  });

  it("re-targets back to the opener when the popup closes", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.created("p1", "http://a/p", "o1");
    await until(() => h.retargets().length === 1, "popup retarget");
    h.tabs.splice(1, 1);
    h.destroyed("p1");
    await until(() => h.retargets().length === 2, "back retarget");
    expect(h.calls.slice(5)).toEqual([["tab", "--json"], ["tab", "t1"], ["stream", "disable"], ["stream", "enable", "--port", String(h.stream.port)]]);
    expect(h.retargets()[1]).toEqual({ tab: "t1", url: "http://a/", reason: "tab_closed" });
  });

  it("publishes the opener's current address after re-targeting when it navigated while the popup was open", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.created("p1", "http://a/p", "o1");
    await until(() => h.retargets().length === 1, "popup retarget");
    h.changed("o1", "http://a/home");
    h.tabs.splice(1, 1);
    h.destroyed("p1");
    await until(() => h.retargets().length === 2, "back retarget");
    await until(() => h.got.filter((m) => m.type === "url").at(-1)?.data.url === "http://a/home", "fresh url");
    const late: LiveViewMessage[] = [];
    h.session.subscribe((m) => late.push(m));
    expect(late.find((m) => m.type === "url")?.data).toEqual({ url: "http://a/home" });
  });

  it("falls back to the most recent remaining page when the opener is gone", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "x", url: "http://x/" }, { tabId: "t3", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.created("x", "http://x/");
    h.created("p1", "http://a/p", "o1");
    await until(() => h.retargets().length === 1, "popup retarget");
    h.destroyed("o1");
    h.tabs.splice(0, 1);
    h.destroyed("p1");
    await until(() => h.retargets().length === 2, "fallback retarget");
    expect(h.retargets()[1]).toMatchObject({ reason: "tab_closed", url: "http://x/" });
  });

  it("does nothing when a non-streamed tab closes or non-page targets appear", async () => {
    const h = await setup();
    h.created("o1", "http://a/");
    h.created("bg", "http://bg/");
    h.created("sw", "http://a/sw.js", "o1", "service_worker");
    h.created("fr", "http://a/frame", "o1", "iframe");
    h.created("wk", "http://a/w.js", "o1", "worker");
    h.destroyed("bg");
    h.destroyed("sw");
    await settle();
    await settle();
    expect(h.calls).toEqual([["stream", "status", "--json"]]);
    expect(h.retargets()).toEqual([]);
  });

  it("resolves a popup that is not in the tab list yet on a later poll", async () => {
    const h = await setup();
    h.created("o1", "http://a/");
    let listCalls = 0;
    h.hooks.gate = (args) => {
      if (args[0] === "tab" && args[1] === "--json" && ++listCalls === 3) {
        h.tabs.push({ tabId: "t2", targetId: "p1", url: "http://a/p" });
      }
      return undefined;
    };
    h.created("p1", "", "o1");
    await until(() => h.retargets().length === 1, "retarget");
    expect(h.calls.filter((c) => c[0] === "tab" && c[1] === "--json")).toHaveLength(3);
  });

  it("serializes quick popups and coalesces to the last desired target", async () => {
    const h = await setup();
    h.tabs.push(
      { tabId: "t1", targetId: "o1", url: "http://a/" },
      { tabId: "t2", targetId: "p1", url: "http://a/1" },
      { tabId: "t3", targetId: "p2", url: "http://a/2" },
      { tabId: "t4", targetId: "p3", url: "http://a/3" },
    );
    h.created("o1", "http://a/");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    h.hooks.gate = (args) => {
      if (first && args[0] === "tab" && args[1] === "--json") {
        first = false;
        return gate;
      }
      return undefined;
    };
    h.created("p1", "http://a/1", "o1");
    await until(() => h.calls.length === 2, "first list");
    h.created("p2", "http://a/2", "o1");
    h.created("p3", "http://a/3", "o1");
    await settle();
    expect(h.calls).toHaveLength(2);
    release();
    await until(() => h.retargets().length === 2, "both retargets");
    expect(h.retargets().map((r) => (r as { tab: string }).tab)).toEqual(["t2", "t4"]);
    expect(h.calls.slice(1).map((c) => c.join(" "))).toEqual([
      "tab --json", "tab t2", "stream disable", `stream enable --port ${h.stream.port}`,
      "tab --json", "tab t4", "stream disable", `stream enable --port ${h.stream.port}`,
    ]);
  });

  it("queues input during a re-target and delivers it once the stream reconnects", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.hooks.gate = (args) => (args[0] === "stream" && args[1] === "disable" ? gate : undefined);
    h.created("p1", "http://a/p", "o1");
    await until(() => h.calls.some((c) => c[1] === "disable"), "mid retarget");
    let settled = false;
    const pending = h.session.sendInput([click]).then((r) => {
      settled = true;
      return r;
    });
    await settle();
    expect(settled).toBe(false);
    expect(h.stream.received).toEqual([]);
    release();
    expect(await pending).toEqual({ ok: true, accepted: 1 });
    await until(() => h.stream.received.length === 1, "delivery");
    expect(h.retargets()).toHaveLength(1);
  });

  it("bounds queued input during a re-target", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.hooks.gate = (args) => (args[0] === "stream" && args[1] === "disable" ? gate : undefined);
    h.created("p1", "http://a/p", "o1");
    await until(() => h.calls.some((c) => c[1] === "disable"), "mid retarget");
    const results = Array.from({ length: 16 }, () => h.session.sendInput([click]));
    expect(await h.session.sendInput([click])).toEqual({ ok: false, reason: "upstream_unavailable" });
    release();
    expect((await Promise.all(results)).every((r) => r.ok)).toBe(true);
  });

  it("retries once then closes with retarget_failed when a step keeps failing", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.hooks.failTab = true;
    h.created("p1", "http://a/p", "o1");
    await until(() => h.got.some((m) => m.type === "closed"), "closed");
    expect(h.got.at(-1)).toEqual({ type: "closed", data: { reason: "retarget_failed" } });
    expect(h.calls.slice(1)).toEqual([["tab", "--json"], ["tab", "t2"], ["tab", "--json"], ["tab", "t2"]]);
    expect(await h.session.sendInput([click])).toEqual({ ok: false, reason: "closed" });
    await until(() => h.stream.clientCount() === 0 && h.cdp.clientCount() === 0, "sockets closed");
  });

  it("recovers when the first attempt fails and the retry succeeds", async () => {
    const h = await setup();
    h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
    h.created("o1", "http://a/");
    h.hooks.failTab = true;
    h.hooks.gate = (args) => {
      if (args[0] === "tab" && args[1] === "--json" && h.calls.filter((c) => c[1] === "--json").length === 2) {
        h.hooks.failTab = false;
      }
      return undefined;
    };
    h.created("p1", "http://a/p", "o1");
    await until(() => h.retargets().length === 1, "retarget");
    expect(h.got.some((m) => m.type === "closed")).toBe(false);
  });

  it("runs no agent-browser command while idle with a first frame, with traffic, or with subscriber churn", async () => {
    const h = await setup();
    h.created("o1", "http://a/");
    h.stream.emit({ type: "frame", data: "first" });
    await settle();
    h.fireTimers();
    for (let i = 0; i < 5; i++) {
      const off = h.session.subscribe(() => {});
      h.stream.emit({ type: "frame", data: `f${i}` });
      h.changed("o1", `http://a/${i}`);
      await h.session.sendInput([click]);
      off();
    }
    await settle();
    await settle();
    expect(h.calls).toEqual([["stream", "status", "--json"]]);
  });

  it("reads the CDP address once with get cdp-url only when the env and request lack it", async () => {
    const h = await setup({ cdpAddress: null });
    await until(() => h.cdp.received.length > 0, "discover");
    expect(h.calls).toEqual([["stream", "status", "--json"], ["get", "cdp-url"]]);
    const fromEnv = await setup({ cdpAddress: null, env: { AGENT_BROWSER_SESSION: "s", AGENT_BROWSER_CDP: "ws://127.0.0.1:1" } });
    expect(fromEnv.calls).toEqual([["stream", "status", "--json"]]);
  });

  it("close during a pending re-target leaves no sockets and stops further commands", async () => {
    const h = await setup({ retryDelayMs: 60_000 });
    h.created("o1", "http://a/");
    h.created("p1", "", "o1");
    await until(() => h.calls.length === 2, "first list poll");
    await h.session.close();
    await until(() => h.stream.clientCount() === 0 && h.cdp.clientCount() === 0, "sockets closed");
    await settle();
    expect(h.calls).toEqual([["stream", "status", "--json"], ["tab", "--json"]]);
    expect(h.got.at(-1)).toEqual({ type: "closed", data: { reason: "closed" } });
  });

  describe("first-frame nudge", () => {
    const restart = (port: number) => [["stream", "disable"], ["stream", "enable", "--port", String(port)]];

    it("restarts the stream once when no frame arrives, and never twice", async () => {
      const h = await setup();
      expect(h.pendingTimers.size).toBe(1);
      h.fireTimers();
      await until(() => h.calls.length === 3 && h.stream.clientCount() === 1, "nudge");
      await settle();
      expect(h.calls).toEqual([["stream", "status", "--json"], ...restart(h.stream.port)]);
      expect(h.pendingTimers.size).toBe(0);
      h.fireTimers();
      h.stream.emit({ type: "frame", data: "now" });
      await settle();
      expect(h.calls).toHaveLength(3);
      expect(h.got.filter((m) => m.type === "frame")).toHaveLength(1);
    });

    it("does not fire when a frame arrives in time", async () => {
      const h = await setup();
      h.stream.emit({ type: "frame", data: "f" });
      await settle();
      h.fireTimers();
      await settle();
      expect(h.calls).toEqual([["stream", "status", "--json"]]);
    });

    it("fires once after a re-target when the new tab is static", async () => {
      const h = await setup();
      h.tabs.push({ tabId: "t1", targetId: "o1", url: "http://a/" }, { tabId: "t2", targetId: "p1", url: "http://a/p" });
      h.created("o1", "http://a/");
      h.stream.emit({ type: "frame", data: "o" });
      await settle();
      h.created("p1", "http://a/p", "o1");
      await until(() => h.retargets().length === 1, "retarget");
      expect(h.pendingTimers.size).toBe(1);
      h.fireTimers();
      await until(() => h.calls.length === 7, "nudge");
      expect(h.calls.slice(5)).toEqual(restart(h.stream.port));
      expect(h.pendingTimers.size).toBe(0);
      h.fireTimers();
      await settle();
      expect(h.calls).toHaveLength(7);
    });

    it("is cancelled by close", async () => {
      const h = await setup();
      await h.session.close();
      expect(h.pendingTimers.size).toBe(0);
      h.fireTimers();
      await settle();
      expect(h.calls).toEqual([["stream", "status", "--json"]]);
    });

    it("queues input during the nudge and delivers it after the reconnect", async () => {
      const h = await setup();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      h.hooks.gate = (args) => (args[1] === "disable" ? gate : undefined);
      h.fireTimers();
      await until(() => h.calls.some((c) => c[1] === "disable"), "mid nudge");
      let settled = false;
      const pending = h.session.sendInput([click]).then((r) => {
        settled = true;
        return r;
      });
      await settle();
      expect(settled).toBe(false);
      expect(h.stream.received).toEqual([]);
      release();
      expect(await pending).toEqual({ ok: true, accepted: 1 });
      await until(() => h.stream.received.length === 1, "delivery");
    });
  });
});

describe("agent-browser live view relay: page dialogs", () => {
  type Cmd = { id: number; method: string; params?: Record<string, any>; sessionId?: string };

  async function dialogSetup(options: { dialogTimeoutMs?: number } = {}) {
    const h = await setupRelay(options);
    const cmds = (): Cmd[] => h.cdp.received.map((r) => JSON.parse(r) as Cmd);
    return {
      ...h,
      cmds,
      attach(targetId: string, sessionId: string, opts: { waiting?: boolean; type?: string; url?: string } = {}) {
        h.cdp.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            waitingForDebugger: opts.waiting === true,
            targetInfo: { targetId, type: opts.type ?? "page", url: opts.url ?? "" },
          },
        });
      },
      opening(sessionId: string, type: string, message: string, defaultPrompt = "") {
        h.cdp.emit({
          method: "Page.javascriptDialogOpening",
          sessionId,
          params: { url: "http://a/", frameId: "fr", message, type, hasBrowserHandler: true, defaultPrompt },
        });
      },
      closedEvent(sessionId: string, result: boolean) {
        h.cdp.emit({ method: "Page.javascriptDialogClosed", sessionId, params: { result, userInput: "" } });
      },
      async replyTo(method: string, payload: Record<string, unknown>, nth = 0): Promise<Cmd> {
        await until(() => cmds().filter((c) => c.method === method).length > nth, `${method} #${nth}`);
        const cmd = cmds().filter((c) => c.method === method)[nth]!;
        h.cdp.emit({ id: cmd.id, ...payload });
        return cmd;
      },
    };
  }

  const SENTINEL = "SENTINEL-dialog-text-3c1f";
  const dialogs = (got: LiveViewMessage[]) => got.filter((m) => m.type === "dialog").map((m) => m.data as Record<string, unknown>);
  const closings = (got: LiveViewMessage[]) => got.filter((m) => m.type === "dialog_closed").map((m) => m.data);

  it("uses browser-level auto-attach after target discovery on its own CDP socket", async () => {
    const h = await dialogSetup();
    await until(() => h.cmds().length >= 2, "setup commands");
    expect(h.cmds().slice(0, 2).map((c) => [c.method, c.params])).toEqual([
      ["Target.setDiscoverTargets", { discover: true }],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ]);
    expect(h.cmds().every((c) => c.sessionId === undefined)).toBe(true);
  });

  it("enables Page without waiting and resumes paused targets, in that order", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.attach("p1", "s-p1", { waiting: true });
    h.attach("w1", "s-w1", { waiting: true, type: "service_worker" });
    h.attach("f1", "s-f1", { type: "iframe" });
    await until(() => h.cmds().length >= 6, "attach commands");
    expect(h.cmds().slice(2).map((c) => [c.method, c.sessionId])).toEqual([
      ["Page.enable", "s-o1"],
      ["Page.enable", "s-p1"],
      ["Runtime.runIfWaitingForDebugger", "s-p1"],
      ["Runtime.runIfWaitingForDebugger", "s-w1"],
    ]);
  });

  it("reports each kind; only confirm and prompt are answerable", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    for (const [i, kind] of (["alert", "confirm", "prompt", "beforeunload"] as const).entries()) {
      h.opening("s-o1", kind, `m-${kind}`, kind === "prompt" ? "dflt" : "");
      await until(() => dialogs(h.got).length === i + 1, kind);
      h.closedEvent("s-o1", true);
    }
    expect(dialogs(h.got)).toEqual([
      { id: "d1", kind: "alert", message: "m-alert", defaultPrompt: "", targetId: "o1", answerable: false },
      { id: "d2", kind: "confirm", message: "m-confirm", defaultPrompt: "", targetId: "o1", answerable: true },
      { id: "d3", kind: "prompt", message: "m-prompt", defaultPrompt: "dflt", targetId: "o1", answerable: true },
      { id: "d4", kind: "beforeunload", message: "m-beforeunload", defaultPrompt: "", targetId: "o1", answerable: false },
    ]);
    await until(() => closings(h.got).length === 4, "closed events");
  });

  it("maps the CDP result to accepted or dismissed and truncates long text", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "x".repeat(5000), "y".repeat(5000));
    await until(() => dialogs(h.got).length === 1, "dialog");
    expect((dialogs(h.got)[0]!.message as string).length).toBe(2000);
    expect((dialogs(h.got)[0]!.defaultPrompt as string).length).toBe(2000);
    h.closedEvent("s-o1", true);
    h.opening("s-o1", "confirm", "again");
    h.closedEvent("s-o1", false);
    await until(() => closings(h.got).length === 2, "closed");
    expect(closings(h.got)).toEqual([
      { id: "d1", result: "accepted" },
      { id: "d2", result: "dismissed" },
    ]);
  });

  it("replays the open dialog after status, tabs and url and before the frame, until it closes", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.stream.emit({ type: "frame", data: "f" });
    h.stream.emit({ type: "status", data: { connected: true } });
    h.stream.emit({ type: "tabs", data: { tabs: [] } });
    h.stream.emit({ type: "url", data: { url: "http://a/" } });
    h.opening("s-o1", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const late: LiveViewMessage[] = [];
    h.session.subscribe((m) => late.push(m));
    expect(late.map((m) => m.type)).toEqual(["status", "tabs", "url", "dialog", "frame"]);
    expect(late.find((m) => m.type === "dialog")?.data).toMatchObject({ id: "d1", message: "ok?" });
    h.closedEvent("s-o1", false);
    await until(() => closings(h.got).length === 1, "closed");
    const later: LiveViewMessage[] = [];
    h.session.subscribe((m) => later.push(m));
    expect(later.map((m) => m.type)).toEqual(["status", "tabs", "url", "frame"]);
  });

  it("answers a confirm with accept or dismiss on that target's session", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.attach("o2", "s-o2");
    h.opening("s-o2", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 1, "dialog");
    expect(dialogs(h.got)[0]!.targetId).toBe("o2");
    const done = h.session.answerDialog({ id: "d1", accept: true, promptText: "ignored" });
    const cmd = await h.replyTo("Page.handleJavaScriptDialog", { result: {} });
    expect(cmd.sessionId).toBe("s-o2");
    expect(cmd.params).toEqual({ accept: true });
    expect(await done).toEqual({ ok: true });
    h.closedEvent("s-o2", true);
    h.opening("s-o2", "confirm", "again");
    await until(() => dialogs(h.got).length === 2, "second");
    const second = h.session.answerDialog({ id: "d2", accept: false });
    const cmd2 = await h.replyTo("Page.handleJavaScriptDialog", { result: {} }, 1);
    expect(cmd2.params).toEqual({ accept: false });
    expect(await second).toEqual({ ok: true });
  });

  it("answers a prompt with text, without text (default sent explicitly) and with dismiss", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    const round = async (n: number, answer: { accept: boolean; promptText?: string }) => {
      h.opening("s-o1", "prompt", "name?", "Ada");
      await until(() => dialogs(h.got).length === n, `prompt ${n}`);
      const done = h.session.answerDialog({ id: `d${n}`, ...answer });
      const cmd = await h.replyTo("Page.handleJavaScriptDialog", { result: {} }, n - 1);
      expect(await done).toEqual({ ok: true });
      h.closedEvent("s-o1", answer.accept);
      return cmd.params;
    };
    expect(await round(1, { accept: true, promptText: "Grace" })).toEqual({ accept: true, promptText: "Grace" });
    expect(await round(2, { accept: true })).toEqual({ accept: true, promptText: "Ada" });
    expect(await round(3, { accept: true, promptText: "" })).toEqual({ accept: true, promptText: "" });
    expect(await round(4, { accept: false, promptText: "ignored" })).toEqual({ accept: false });
  });

  it("allows one answer per dialog and reports a late answer as no_dialog", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const first = h.session.answerDialog({ id: "d1", accept: true });
    expect(await h.session.answerDialog({ id: "d1", accept: false })).toEqual({ ok: false, reason: "no_dialog" });
    await h.replyTo("Page.handleJavaScriptDialog", { result: {} });
    expect(await first).toEqual({ ok: true });
    h.closedEvent("s-o1", true);
    await until(() => closings(h.got).length === 1, "closed");
    expect(await h.session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
    expect(await h.session.answerDialog({ id: "d99", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
    expect(h.cmds().filter((c) => c.method === "Page.handleJavaScriptDialog")).toHaveLength(1);
  });

  it("treats -32602 'No dialog is showing' as no_dialog", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const done = h.session.answerDialog({ id: "d1", accept: true });
    await h.replyTo("Page.handleJavaScriptDialog", { error: { code: -32602, message: "No dialog is showing" } });
    expect(await done).toEqual({ ok: false, reason: "no_dialog" });
    h.closedEvent("s-o1", true);
    await until(() => closings(h.got).length === 1, "closed");
  });

  it("returns closed and lets a retry through when another CDP error occurs", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const done = h.session.answerDialog({ id: "d1", accept: true });
    await h.replyTo("Page.handleJavaScriptDialog", { error: { code: -32000, message: "boom" } });
    expect(await done).toEqual({ ok: false, reason: "closed" });
    const retry = h.session.answerDialog({ id: "d1", accept: true });
    await h.replyTo("Page.handleJavaScriptDialog", { result: {} }, 1);
    expect(await retry).toEqual({ ok: true });
  });

  it("rejects read-only dialogs, bad shapes, and answers after close", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "alert", "hi");
    await until(() => dialogs(h.got).length === 1, "dialog");
    expect(await h.session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "not_answerable" });
    for (const bad of [
      { id: 1, accept: true },
      { id: "", accept: true },
      { id: "d1", accept: "yes" },
      { id: "d1", accept: true, promptText: 5 },
      { id: "d1", accept: true, promptText: "x".repeat(2001) },
      null,
    ]) {
      expect(await h.session.answerDialog(bad as never)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(h.cmds().some((c) => c.method === "Page.handleJavaScriptDialog")).toBe(false);
    await h.session.close();
    expect(await h.session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "closed" });
  });

  it("dismisses an unanswered confirm or prompt after the time-out, then reports timeout once", async () => {
    const h = await dialogSetup({ dialogTimeoutMs: 4321 });
    h.attach("o1", "s-o1");
    h.opening("s-o1", "prompt", "name?", "Ada");
    await until(() => dialogs(h.got).length === 1, "dialog");
    expect(h.timersWithMs(4321)).toBe(1);
    h.fireTimersWithMs(4321);
    const cmd = await h.replyTo("Page.handleJavaScriptDialog", { result: {} });
    expect(cmd.params).toEqual({ accept: false });
    expect(cmd.sessionId).toBe("s-o1");
    await until(() => closings(h.got).length === 1, "timeout close");
    expect(closings(h.got)).toEqual([{ id: "d1", result: "timeout" }]);
    h.closedEvent("s-o1", false);
    await settle();
    expect(closings(h.got)).toHaveLength(1);
    expect(h.timersWithMs(4321)).toBe(0);
  });

  it("defaults the time-out to 60 s and sets no timer for read-only dialogs", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "alert", "hi");
    h.opening("s-o1", "beforeunload", "");
    await until(() => dialogs(h.got).length === 2, "dialogs");
    expect(h.timersWithMs(60_000)).toBe(0);
    h.opening("s-o1", "confirm", "ok?");
    await until(() => dialogs(h.got).length === 3, "confirm");
    expect(h.timersWithMs(60_000)).toBe(1);
  });

  it("cancels the time-out when the dialog closes, is answered, or the relay closes", async () => {
    const h = await dialogSetup({ dialogTimeoutMs: 777 });
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "a");
    await until(() => h.timersWithMs(777) === 1, "timer");
    h.closedEvent("s-o1", true);
    await until(() => h.timersWithMs(777) === 0, "cancelled by close");
    h.opening("s-o1", "confirm", "b");
    await until(() => h.timersWithMs(777) === 1, "timer 2");
    await h.session.close();
    expect(h.timersWithMs(777)).toBe(0);
    expect(h.cmds().some((c) => c.method === "Page.handleJavaScriptDialog")).toBe(false);
  });

  it("an answer in flight is not overridden by the time-out", async () => {
    const h = await dialogSetup({ dialogTimeoutMs: 777 });
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "a");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const done = h.session.answerDialog({ id: "d1", accept: true });
    h.fireTimersWithMs(777);
    await h.replyTo("Page.handleJavaScriptDialog", { result: {} });
    await done;
    expect(h.cmds().filter((c) => c.method === "Page.handleJavaScriptDialog")).toHaveLength(1);
  });

  it("reports a popup's onload dialog: attached and paused before it runs, then closed when it goes away", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1", { url: "http://a/" });
    h.attach("p1", "s-p1", { waiting: true, url: "about:blank" });
    await until(() => h.cmds().some((c) => c.method === "Runtime.runIfWaitingForDebugger"), "resume");
    const popupCmds = h.cmds().filter((c) => c.sessionId === "s-p1").map((c) => c.method);
    expect(popupCmds).toEqual(["Page.enable", "Runtime.runIfWaitingForDebugger"]);
    h.opening("s-p1", "confirm", "from the popup");
    await until(() => dialogs(h.got).length === 1, "popup dialog");
    expect(dialogs(h.got)[0]).toMatchObject({ targetId: "p1", message: "from the popup", answerable: true });
    h.cdp.emit({ method: "Target.targetDestroyed", params: { targetId: "p1" } });
    await until(() => closings(h.got).length === 1, "closed");
    expect(closings(h.got)).toEqual([{ id: "d1", result: "closed_by_page" }]);
    expect(await h.session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
  });

  it("drops a target's session and dialog on detach, and ignores events from unknown sessions", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("ghost", "confirm", "nobody");
    h.opening("s-o1", "confirm", "a");
    await until(() => dialogs(h.got).length === 1, "dialog");
    h.cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "s-o1", targetId: "o1" } });
    await until(() => closings(h.got).length === 1, "closed");
    expect(closings(h.got)).toEqual([{ id: "d1", result: "closed_by_page" }]);
    h.opening("s-o1", "confirm", "after detach");
    await settle();
    expect(dialogs(h.got)).toHaveLength(1);
  });

  it("closes open dialogs when the CDP socket drops, while the stream keeps working", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "a");
    await until(() => dialogs(h.got).length === 1, "dialog");
    h.cdp.dropClients();
    await until(() => closings(h.got).length === 1, "closed");
    expect(await h.session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
    h.stream.emit({ type: "frame", data: "still" });
    await until(() => h.got.some((m) => m.type === "frame"), "frame");
  });

  it("stays usable when Page.enable never resolves (relay restart with a dialog already open)", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    await until(() => h.cmds().some((c) => c.method === "Page.enable"), "enable sent");
    await settle();
    h.stream.emit({ type: "frame", data: "f" });
    h.stream.emit({ type: "url", data: { url: "http://a/" } });
    await until(() => h.got.some((m) => m.type === "frame") && h.got.some((m) => m.type === "url"), "stream flows");
    expect(await h.session.sendInput([click])).toEqual({ ok: true, accepted: 1 });
    h.opening("s-o1", "confirm", "later dialog is still seen");
    await until(() => dialogs(h.got).length === 1, "dialog");
    expect(await h.session.answerDialog({ id: "d2", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
    await h.session.close();
    expect(h.got.at(-1)).toEqual({ type: "closed", data: { reason: "closed" } });
  });

  it("answers pending calls with closed when the relay closes mid-answer", async () => {
    const h = await dialogSetup();
    h.attach("o1", "s-o1");
    h.opening("s-o1", "confirm", "a");
    await until(() => dialogs(h.got).length === 1, "dialog");
    const done = h.session.answerDialog({ id: "d1", accept: true });
    await until(() => h.cmds().some((c) => c.method === "Page.handleJavaScriptDialog"), "sent");
    await h.session.close();
    expect(await done).toEqual({ ok: false, reason: "closed" });
  });

  it("runs no agent-browser command for dialogs and never exposes dialog text outside messages", async () => {
    const captured: string[] = [];
    const grab = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return true;
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(grab));
    try {
      const h = await dialogSetup({ dialogTimeoutMs: 55 });
      h.attach("o1", "s-o1");
      h.opening("s-o1", "prompt", SENTINEL, SENTINEL);
      await until(() => dialogs(h.got).length === 1, "dialog");
      const results = [
        await h.session.answerDialog({ id: "nope", accept: true, promptText: SENTINEL }),
        await h.session.answerDialog({ id: "d1", accept: true, promptText: 5 as never }),
      ];
      const failing = h.session.answerDialog({ id: "d1", accept: true, promptText: SENTINEL });
      await h.replyTo("Page.handleJavaScriptDialog", { error: { code: -32000, message: SENTINEL } });
      results.push(await failing);
      h.fireTimersWithMs(55);
      await h.replyTo("Page.handleJavaScriptDialog", { error: { code: -32602, message: SENTINEL } }, 1);
      await until(() => closings(h.got).length === 1, "timeout close");
      expect(h.calls).toEqual([["stream", "status", "--json"]]);
      expect(JSON.stringify({ results, closings: closings(h.got), captured })).not.toContain(SENTINEL);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("fake live view relay: page dialogs", () => {
  const confirmDialog = { id: "d1", kind: "confirm", message: "ok?", defaultPrompt: "", targetId: "t", answerable: true };

  it("replays an open dialog after url and before the frame, and forgets it on close", async () => {
    const relay = createFakeLiveViewRelay();
    const session = await relay.open(request);
    const fake = relay.sessions[0]!;
    fake.emit({ type: "frame", data: { data: "f" } });
    fake.emit({ type: "url", data: { url: "u" } });
    fake.emit({ type: "dialog", data: confirmDialog });
    const late: LiveViewMessage[] = [];
    session.subscribe((m) => late.push(m));
    expect(late.map((m) => m.type)).toEqual(["url", "dialog", "frame"]);
    fake.emit({ type: "dialog_closed", data: { id: "d1", result: "accepted" } });
    const later: LiveViewMessage[] = [];
    session.subscribe((m) => later.push(m));
    expect(later.map((m) => m.type)).toEqual(["url", "frame"]);
  });

  it("follows the same answer rules as the real relay", async () => {
    const relay = createFakeLiveViewRelay();
    const session = await relay.open(request);
    const fake = relay.sessions[0]!;
    fake.emit({ type: "dialog", data: confirmDialog });
    fake.emit({ type: "dialog", data: { ...confirmDialog, id: "d2", kind: "alert", answerable: false } });
    expect(await session.answerDialog({ id: "d2", accept: true })).toEqual({ ok: false, reason: "not_answerable" });
    expect(await session.answerDialog({ id: "d1", accept: "x" as never })).toEqual({ ok: false, reason: "invalid" });
    expect(await session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: true });
    expect(await session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "no_dialog" });
    expect(fake.answers).toEqual([{ id: "d1", accept: true }]);
    await session.close();
    expect(await session.answerDialog({ id: "d1", accept: true })).toEqual({ ok: false, reason: "closed" });
  });
});
