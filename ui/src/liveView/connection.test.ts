import { describe, expect, it } from "vitest";
import {
  createLiveViewConnection,
  RETARGET_NOTICE,
  type ConnectionDeps,
  type EventSourceLike,
  type LiveViewState,
  type TicketResult,
} from "./connection";

class FakeSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, (ev: { data?: string }) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data?: string }) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    this.listeners.get(type)?.({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function setup(tickets: TicketResult[] = [], extra: Partial<ConnectionDeps> = {}) {
  const sources: FakeSource[] = [];
  const states: LiveViewState[] = [];
  const frames: string[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let n = 0;
  const conn = createLiveViewConnection({
    mode: "control",
    baseUrl: "/api/runs/r/stages/s/live-view",
    requestTicket: async () => tickets.shift() ?? { ticket: `t${(n += 1)}` },
    openEventSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    onState: (s) => states.push(s),
    onFrame: (f) => frames.push(f.data),
    ...extra,
  });
  const last = () => states[states.length - 1]!;
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { conn, sources, states, frames, timers, last, tick };
}

describe("live view connection", () => {
  it("goes waiting -> live and opens the stream with the ticket only", async () => {
    const h = setup([{ ticket: "abc" }]);
    h.conn.start();
    await h.tick();
    expect(h.sources[0]!.url).toBe("/api/runs/r/stages/s/live-view/events?ticket=abc");
    expect(h.sources[0]!.url).not.toMatch(/Bearer|token=/i);
    h.sources[0]!.onopen?.(null);
    expect(h.last().phase).toBe("waiting");
    h.sources[0]!.emit("frame", { data: "AAAA", metadata: { deviceWidth: 720 } });
    expect(h.last()).toMatchObject({ phase: "live", hasFrame: true });
    expect(h.frames).toEqual(["AAAA"]);
    h.sources[0]!.emit("url", { url: "https://example.com/login" });
    expect(h.last().url).toBe("https://example.com/login");
  });

  it("reconnects with a NEW ticket and bounded backoff", async () => {
    const h = setup([{ ticket: "one" }, { ticket: "two" }]);
    h.conn.start();
    await h.tick();
    h.sources[0]!.onopen?.(null);
    h.sources[0]!.emit("frame", { data: "x" });
    h.sources[0]!.onerror?.(null);
    expect(h.last().phase).toBe("reconnecting");
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.timers[0]!.ms).toBe(1000);
    h.timers[0]!.fn();
    await h.tick();
    expect(h.sources[1]!.url).toContain("ticket=two");
    h.sources[1]!.onopen?.(null);
    expect(h.last().phase).toBe("live");
  });

  it("caps the backoff delay and gives up after repeated failures", async () => {
    const h = setup([], { maxFailures: 4, maxDelayMs: 3000 });
    h.conn.start();
    await h.tick();
    for (let i = 0; i < 4; i++) {
      h.sources[i]!.onerror?.(null);
      const t = h.timers[h.timers.length - 1]!;
      expect(t.ms).toBeLessThanOrEqual(3000);
      t.fn();
      await h.tick();
    }
    h.sources[4]!.onerror?.(null);
    expect(h.last()).toMatchObject({ phase: "closed", closedReason: "connection_lost" });
  });

  it("shows a retarget notice and clears it", async () => {
    const h = setup();
    h.conn.start();
    await h.tick();
    h.sources[0]!.emit("retarget", { tab: "t2", url: "https://popup.example", reason: "popup" });
    expect(h.last().notice).toBe(RETARGET_NOTICE);
    expect(h.last().url).toBe("https://popup.example");
    h.timers[h.timers.length - 1]!.fn();
    expect(h.last().notice).toBeNull();
  });

  it("stops on closed and does not reconnect", async () => {
    const h = setup();
    h.conn.start();
    await h.tick();
    h.sources[0]!.emit("closed", { reason: "revoked" });
    expect(h.last()).toMatchObject({ phase: "closed", closedReason: "revoked" });
    expect(h.sources[0]!.closed).toBe(true);
    h.sources[0]!.onerror?.(null);
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("closes as unavailable when the ticket is refused with 409", async () => {
    const h = setup([{ status: 409 }]);
    h.conn.start();
    await h.tick();
    expect(h.last()).toMatchObject({ phase: "closed", closedReason: "unavailable" });
    expect(h.sources).toHaveLength(0);
  });

  it("refresh opens a stream with a new ticket immediately", async () => {
    const h = setup([{ ticket: "a" }, { ticket: "b" }]);
    h.conn.start();
    await h.tick();
    h.sources[0]!.onopen?.(null);
    const pending = h.conn.refresh();
    await h.tick();
    h.sources[1]!.onopen?.(null);
    await expect(pending).resolves.toBe(true);
    expect(h.sources[0]!.closed).toBe(true);
  });

  it("dispose drops the connection", async () => {
    const h = setup();
    h.conn.start();
    await h.tick();
    h.conn.dispose();
    expect(h.sources[0]!.closed).toBe(true);
  });

  it("requests a view ticket in view mode", async () => {
    const modes: string[] = [];
    const h = setup([], {
      mode: "view",
      requestTicket: async (m) => (modes.push(m), { ticket: "v" }),
    });
    h.conn.start();
    await h.tick();
    expect(modes).toEqual(["view"]);
  });
});

describe("live view connection: page dialogs", () => {
  const confirm = { id: "d1", kind: "confirm", message: "Sure?", defaultPrompt: "", targetId: "t", answerable: true };

  async function open() {
    const h = setup([{ ticket: "a" }]);
    h.conn.start();
    await h.tick();
    h.sources[0]!.onopen?.(null);
    return h;
  }

  it("tracks an open dialog and clears it on dialog_closed", async () => {
    const h = await open();
    h.sources[0]!.emit("dialog", confirm);
    expect(h.last().dialog).toMatchObject({ id: "d1", kind: "confirm", message: "Sure?", answerable: true });
    h.sources[0]!.emit("dialog_closed", { id: "d1", result: "accepted" });
    expect(h.last().dialog).toBeNull();
    expect(h.last().notice).toBeNull();
  });

  it("shows the time-out notice", async () => {
    const h = await open();
    h.sources[0]!.emit("dialog", confirm);
    h.sources[0]!.emit("dialog_closed", { id: "d1", result: "timeout" });
    expect(h.last().dialog).toBeNull();
    expect(h.last().notice).toBe("The page dialog was dismissed after waiting too long.");
  });

  it("keeps an alert visible for the notice time, then clears it", async () => {
    const h = await open();
    h.sources[0]!.emit("dialog", { ...confirm, kind: "alert", answerable: false });
    h.sources[0]!.emit("dialog_closed", { id: "d1", result: "accepted" });
    expect(h.last().dialog).toMatchObject({ kind: "alert", autoClosed: true });
    const linger = h.timers.at(-1)!;
    expect(linger.ms).toBe(5000);
    linger.fn();
    expect(h.last().dialog).toBeNull();
  });

  it("ignores malformed dialog events and a close for another dialog", async () => {
    const h = await open();
    h.sources[0]!.emit("dialog", { id: 1 });
    expect(h.last().dialog).toBeNull();
    h.sources[0]!.emit("dialog", confirm);
    h.sources[0]!.emit("dialog_closed", { id: "other", result: "timeout" });
    expect(h.last().dialog).toMatchObject({ id: "d1" });
  });

  it("drops the dialog when the stream ends or reconnects, so the replay restores it", async () => {
    const h = await open();
    h.sources[0]!.emit("dialog", confirm);
    h.sources[0]!.onerror?.(null);
    expect(h.last().dialog).toBeNull();
    h.sources[0]!.emit("closed", { reason: "revoked" });
    expect(h.last().dialog).toBeNull();
  });
});
