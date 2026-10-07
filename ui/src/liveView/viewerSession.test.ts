import { describe, expect, it } from "vitest";
import type { EventSourceLike, TicketResult } from "./connection";
import type { LiveViewInput } from "./types";
import { createViewerSession, type ViewerSessionDeps } from "./viewerSession";

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

type Listener = (e: any) => void;
class FakeTarget {
  map = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.map.get(type)?.delete(fn);
  }
  count() {
    let n = 0;
    for (const s of this.map.values()) n += s.size;
    return n;
  }
  fire(type: string, e: object) {
    for (const fn of [...(this.map.get(type) ?? [])]) fn({ preventDefault() {}, ...e });
  }
}

function setup(opts: { tickets?: TicketResult[]; inputStatuses?: number[]; mode?: "control" | "view" } = {}) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const posts: LiveViewInput[][] = [];
  const dialogPosts: { id: string }[] = [];
  const dialogStatuses: number[] = [];
  const frames: string[] = [];
  const canvas = new FakeTarget();
  const win = new FakeTarget();
  const tickets = opts.tickets ?? [];
  const inputStatuses = opts.inputStatuses ?? [];
  let n = 0;
  let clock = 0;
  const deps: ViewerSessionDeps = {
    mode: opts.mode ?? "control",
    baseUrl: "/live",
    surface: {
      canvas,
      textarea: null,
      win,
      getRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      getImageSize: () => ({ width: 1280, height: 720 }),
      drawFrame: (d) => frames.push(d),
    },
    requestTicket: async () => tickets.shift() ?? { ticket: `t${(n += 1)}` },
    postInput: async (_url, batch) => {
      posts.push(batch);
      return inputStatuses.shift() ?? 200;
    },
    postDialog: async (_url, body) => {
      dialogPosts.push(body);
      return dialogStatuses.shift() ?? 200;
    },
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
    now: () => (clock += 1000),
  };
  const session = createViewerSession(deps);
  const tick = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const click = () => canvas.fire("mousedown", { clientX: 10, clientY: 10, button: 0, detail: 1 });
  const last = () => sources[sources.length - 1]!;
  const runTimers = async () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    await tick();
  };
  return { session, sources, posts, dialogPosts, dialogStatuses, frames, canvas, win, tick, click, last, runTimers, timers };
}

async function openLive(h: ReturnType<typeof setup>) {
  h.session.start();
  await h.tick();
  h.last().onopen?.({});
  h.last().emit("frame", { data: "AAA" });
  await h.tick();
}

describe("viewer session", () => {
  it("connects, draws frames, and forwards pointer input to the server", async () => {
    const h = setup();
    await openLive(h);
    expect(h.session.getState().connection.phase).toBe("live");
    expect(h.frames).toEqual(["AAA"]);
    h.click();
    await h.tick();
    expect(h.posts.flat()[0]).toMatchObject({ type: "input_mouse", eventType: "mousePressed" });
  });

  it("notifies subscribers and returns a stable snapshot between changes", async () => {
    const h = setup();
    let calls = 0;
    h.session.subscribe(() => (calls += 1));
    await openLive(h);
    expect(calls).toBeGreaterThan(0);
    expect(h.session.getState()).toBe(h.session.getState());
  });

  it("restarts input after a 409 once the connection reconnects with a fresh ticket", async () => {
    const h = setup({ inputStatuses: [409] });
    await openLive(h);
    h.click();
    await h.tick();
    expect(h.session.getState().inputStopped).toBe(true);
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(1);

    h.last().onerror?.({});
    await h.tick();
    expect(h.session.getState().connection.phase).toBe("reconnecting");
    await h.runTimers();
    h.last().onopen?.({});
    await h.tick();
    expect(h.session.getState().inputStopped).toBe(false);
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(2);
  });

  it("restarts input when a closed session is reopened with the same URL", async () => {
    const h = setup();
    await openLive(h);
    h.last().emit("closed", { reason: "stage_ended" });
    await h.tick();
    expect(h.session.getState().connection.phase).toBe("closed");
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(0);

    const before = h.sources.length;
    h.session.reopen();
    await h.tick();
    expect(h.sources.length).toBe(before + 1);
    h.last().onopen?.({});
    h.last().emit("frame", { data: "BBB" });
    await h.tick();
    expect(h.session.getState().connection.phase).toBe("live");
    expect(h.session.getState().inputStopped).toBe(false);
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(1);
    expect(h.frames).toEqual(["AAA", "BBB"]);
  });

  it("reopen clears a latched input stop and ignores the old connection", async () => {
    const h = setup({ inputStatuses: [409] });
    await openLive(h);
    const old = h.last();
    h.click();
    await h.tick();
    expect(h.session.getState().inputStopped).toBe(true);
    h.session.reopen();
    await h.tick();
    old.emit("frame", { data: "STALE" });
    expect(h.frames).not.toContain("STALE");
    expect(h.session.getState().inputStopped).toBe(false);
  });

  it("resets dialog answered state when a new dialog opens", async () => {
    const h = setup();
    await openLive(h);
    const dialog = { id: "d1", kind: "confirm", message: "ok?", answerable: true };
    h.last().emit("dialog", dialog);
    expect(h.session.getState().dialog?.id).toBe("d1");
    h.session.answerDialog({ id: "d1", accept: true });
    await h.tick();
    expect(h.dialogPosts).toEqual([{ id: "d1", accept: true }]);
    expect(h.session.getState().dialog).toBeNull();
    expect(h.session.getState().answering).toBe(false);

    h.last().emit("dialog_closed", { id: "d1", result: "accepted" });
    h.last().emit("dialog", dialog);
    expect(h.session.getState().dialog?.id).toBe("d1");
  });

  it("surfaces a failed dialog answer and clears it on the next dialog", async () => {
    const h = setup();
    await openLive(h);
    h.dialogStatuses.push(500);
    h.last().emit("dialog", { id: "d1", kind: "confirm", message: "", answerable: true });
    h.session.answerDialog({ id: "d1", accept: true });
    await h.tick();
    expect(h.session.getState().answerFailed).not.toBeNull();
    expect(h.session.getState().dialog?.id).toBe("d1");
    h.last().emit("dialog", { id: "d2", kind: "confirm", message: "", answerable: true });
    expect(h.session.getState().answerFailed).toBeNull();
  });

  it("dispose stops the connection, input registration, queue and notifications", async () => {
    const h = setup();
    await openLive(h);
    expect(h.canvas.count()).toBeGreaterThan(0);
    expect(h.win.count()).toBeGreaterThan(0);
    let calls = 0;
    h.session.subscribe(() => (calls += 1));
    const src = h.last();
    h.session.dispose();
    expect(src.closed).toBe(true);
    expect(h.canvas.count()).toBe(0);
    expect(h.win.count()).toBe(0);
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(0);
    src.emit("frame", { data: "LATE" });
    expect(h.frames).not.toContain("LATE");
    expect(calls).toBe(0);
    h.session.reopen();
    await h.tick();
    expect(h.sources).toHaveLength(1);
  });

  it("view mode registers no input and never posts", async () => {
    const h = setup({ mode: "view" });
    await openLive(h);
    expect(h.canvas.count()).toBe(0);
    h.click();
    await h.tick();
    expect(h.posts).toHaveLength(0);
  });
});
