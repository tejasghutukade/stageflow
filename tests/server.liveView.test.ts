import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import { createFakeLiveViewRelay } from "../src/browser/fakeLiveViewRelay.js";
import type { LiveViewRelay, LiveViewSessionRequest } from "../src/browser/liveViewRelay.js";
import { createLiveViewTicketService } from "../src/browser/liveViewTickets.js";
import type { RunStore } from "../src/runstore/port.js";
import { stageDir } from "../src/runstore/paths.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { resolveAllowedHosts } from "../src/server/allowedHosts.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { json } from "../src/server/createHttpHost.js";
import { createOperatorRoutes } from "../src/server/http.js";
import { LIVE_VIEW_CSRF_HEADER, LIVE_VIEW_MAX_DIALOG_BYTES, LIVE_VIEW_MAX_INPUT_BYTES } from "../src/server/liveViewRoutes.js";

const DRIVE = "d".repeat(32);
const READ = "r".repeat(32);
const BASE = "/api/runs/run-1/stages/login/live-view";
const GATE = {
  kind: "confirm",
  id: "p1",
  message: "log in",
  handoff: { kind: "live_view", url: BASE },
  profile: "work",
};

type FakeStage = { stage_id: string; status: string; pending_prompt?: unknown };

type Harness = Awaited<ReturnType<typeof startHarness>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startHarness(
  opts: {
    tokens?: boolean;
    relay?: LiveViewRelay;
    scopeHeader?: boolean;
    root?: string;
    stageStatuses?: Record<string, string>;
  } = {},
) {
  const root = opts.root ?? (await mkdtemp(path.join(tmpdir(), "sf-live-view-")));
  const stages: FakeStage[] = [
    { stage_id: "login", status: "waiting_for_input", pending_prompt: GATE },
    { stage_id: "watch", status: "running" },
    { stage_id: "plain", status: "running" },
    { stage_id: "local", status: "waiting_for_input", pending_prompt: { ...GATE, handoff: { kind: "local_window" } } },
    { stage_id: "done", status: "succeeded" },
  ];
  for (const stage of stages) stage.status = opts.stageStatuses?.[stage.stage_id] ?? stage.status;
  for (const id of ["login", "watch", "local", "done"]) {
    const dir = stageDir(path.join(root, "run-1"), id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "browser-env.json"), JSON.stringify({ AGENT_BROWSER_SESSION: `s-${id}` }));
  }
  const anchorDir = path.join(root, "run-1", "browser", "work");
  await mkdir(anchorDir, { recursive: true });
  await writeFile(
    path.join(anchorDir, "anchor.json"),
    JSON.stringify({ cdpAddress: "ws://127.0.0.1:9222", anchorEnv: { A: "1" }, runId: "run-1", profile: "work", restarts: 0 }),
  );

  const storeEvents: unknown[] = [];
  const store = {
    readRun: async (runId: string) => {
      if (runId !== "run-1") throw new Error(`Run not found: ${runId}`);
      return { stages };
    },
    getWorkspaceDir: (runId: string) => path.join(root, runId),
    appendStageEvent: async (...args: unknown[]) => {
      storeEvents.push(args);
    },
  } as unknown as RunStore;

  const gateListeners = new Set<(runId: string, stageId?: string) => void>();
  const manager = {
    onGateClosed(listener: (runId: string, stageId?: string) => void) {
      gateListeners.add(listener);
      return () => gateListeners.delete(listener);
    },
    beforeBrowserTeardown(listener: (input: { runId: string; stageId?: string }) => Promise<void> | void) {
      teardownListeners.add(listener);
      return () => teardownListeners.delete(listener);
    },
    onShutdown(listener: () => void) {
      shutdownListeners.add(listener);
      return () => shutdownListeners.delete(listener);
    },
  } as unknown as RunManager;
  const fire = (runId: string, stageId?: string) => gateListeners.forEach((l) => l(runId, stageId));
  const teardownListeners = new Set<(input: { runId: string; stageId?: string }) => Promise<void> | void>();
  const shutdownListeners = new Set<() => void>();
  const teardown = async (runId: string, stageId?: string) => {
    await Promise.all([...teardownListeners].map((l) => l({ runId, ...(stageId !== undefined ? { stageId } : {}) })));
  };
  const shutdown = () => shutdownListeners.forEach((l) => l());

  const fake = createFakeLiveViewRelay();
  const opened: LiveViewSessionRequest[] = [];
  const relay: LiveViewRelay = opts.relay ?? {
    open: (request) => {
      opened.push(request);
      return fake.open(request);
    },
  };
  const audit = createMemoryAuditSink();
  const clock = { at: 1_000_000 };
  const beats: Array<() => void> = [];
  const clearedBeats = new Set<number>();
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const tickets = createLiveViewTicketService({ now: () => clock.at });

  const routes = createOperatorRoutes({
    manager,
    store,
    cwd: root,
    agentDir: root,
    rootDir: root,
    providerAuthContext: undefined,
    allowedHosts: resolveAllowedHosts({}),
    controlTokens: loadControlTokens(opts.tokens ? { STAGEFLOW_CONTROL_TOKEN: DRIVE, STAGEFLOW_READ_TOKEN: READ } : {}),
    liveView: {
      relay,
      audit,
      tickets,
      now: () => clock.at,
      heartbeatMs: 15_000,
      setHeartbeat: (fn) => {
        beats.push(fn);
        return beats.length - 1;
      },
      clearHeartbeat: (handle) => {
        beats[handle as number] = () => undefined;
        clearedBeats.add(handle as number);
      },
      setTimer: (fn) => {
        const entry = {
          fn: () => {
            entry.cleared = true;
            fn();
          },
          cleared: false,
        };
        timers.push(entry);
        return entry;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      ...(opts.scopeHeader
        ? { resolveScope: (req) => String(req.headers["x-scope"] ?? "scope-a") }
        : {}),
    },
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await routes({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      json,
      boot: {} as never,
    });
    if (!handled) json(res, 404, { error: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function post(
    pathname: string,
    body: unknown,
    headers: Record<string, string> = {},
    raw = false,
  ) {
    const res = await fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  }

  async function ticket(mode: "view" | "control", stage = "login", headers: Record<string, string> = {}) {
    const res = await post(`/api/runs/run-1/stages/${stage}/live-view/ticket`, { mode }, headers);
    return res;
  }

  function stream(pathname: string, headers: Record<string, string> = {}) {
    return new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      events: Array<{ event: string; data: string }>;
      raw: () => string;
      ended: () => boolean;
      waitFor: (event: string, count?: number) => Promise<void>;
      close: () => void;
    }>((resolve, reject) => {
      const req = httpRequest(`${origin}${pathname}`, { headers }, (res) => {
        let buffer = "";
        let all = "";
        let isEnded = false;
        const events: Array<{ event: string; data: string }> = [];
        const waiters: Array<() => void> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          all += chunk;
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const ev = /^event: (.*)$/m.exec(part)?.[1];
            const data = /^data: (.*)$/m.exec(part)?.[1];
            if (ev !== undefined) events.push({ event: ev, data: data ?? "" });
          }
          waiters.forEach((w) => w());
        });
        res.on("end", () => {
          isEnded = true;
          waiters.forEach((w) => w());
        });
        const state = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          raw: () => all,
          ended: () => isEnded,
          waitFor: (event: string, count = 1) =>
            new Promise<void>((resolveWait, rejectWait) => {
              const timer = setTimeout(() => rejectWait(new Error(`timeout waiting for ${event}`)), 3000);
              const check = () => {
                if (events.filter((e) => e.event === event).length >= count) {
                  clearTimeout(timer);
                  resolveWait();
                  return true;
                }
                return false;
              };
              if (!check()) waiters.push(() => void check());
            }),
          close: () => req.destroy(),
        };
        if (res.statusCode !== 200) {
          res.on("end", () => resolve(state));
          res.resume();
          return;
        }
        resolve(state);
      });
      req.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
      });
      req.end();
    });
  }

  async function openControl(stage = "login") {
    const t = await ticket("control", stage);
    const s = await stream(`/api/runs/run-1/stages/${stage}/live-view/events?ticket=${t.body.ticket}`);
    const cookie = String(s.headers["set-cookie"]).split(";")[0]!;
    return { stream: s, cookie };
  }

  const inputHeaders = (cookie: string, extra: Record<string, string> = {}) => ({
    cookie,
    origin,
    [LIVE_VIEW_CSRF_HEADER]: "1",
    ...extra,
  });

  return {
    origin, post, ticket, stream, openControl, inputHeaders, fake, opened, audit, clock, beats,
    timers, pendingTimers: () => timers.filter((t) => !t.cleared).length,
    liveBeats: () => beats.length - clearedBeats.size, storeEvents, fire, stages, tickets, root, routes, teardown, shutdown,
  };
}

const click = { type: "input_mouse", eventType: "mousePressed", x: 1, y: 2, button: "left" };
const flush = () => new Promise((r) => setTimeout(r, 25));

describe("live view tickets", () => {
  it("issues control only while the stage waits at a live_view gate", async () => {
    const h = await startHarness();
    const ok = await h.ticket("control");
    expect(ok.status).toBe(200);
    expect(typeof ok.body.ticket).toBe("string");
    expect(ok.body.expires_at).toBe(new Date(h.clock.at + 60_000).toISOString());
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-frame-options")).toBe("DENY");
    expect(ok.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await h.ticket("control", "local")).status).toBe(409);
    expect((await h.ticket("control", "watch")).status).toBe(409);
    expect((await h.ticket("control", "nope")).status).toBe(404);
    const missingRun = await h.post("/api/runs/other/stages/login/live-view/ticket", { mode: "view" });
    expect(missingRun.status).toBe(404);
  });

  it("issues view for a running or waiting browser stage only", async () => {
    const h = await startHarness();
    expect((await h.ticket("view", "watch")).status).toBe(200);
    expect((await h.ticket("view", "login")).status).toBe(200);
    expect((await h.ticket("view", "plain")).status).toBe(409);
    expect((await h.ticket("view", "done")).status).toBe(409);
    expect((await h.ticket("view", "nope")).status).toBe(404);
    const bad = await h.post(`${BASE}/ticket`, { mode: "admin" });
    expect(bad.status).toBe(400);
    expect((await h.post(`${BASE}/ticket`, "{nope", {}, true)).status).toBe(400);
  });

  it("requires read scope for view and drive scope for control when tokens are set", async () => {
    const h = await startHarness({ tokens: true });
    expect((await h.ticket("view")).status).toBe(401);
    const read = { authorization: `Bearer ${READ}` };
    const drive = { authorization: `Bearer ${DRIVE}` };
    expect((await h.ticket("view", "login", read)).status).toBe(200);
    expect((await h.ticket("control", "login", read)).status).toBe(403);
    expect((await h.ticket("control", "login", drive)).status).toBe(200);
  });

  it("a ticket is single use, expires, and is bound to its stage", async () => {
    const h = await startHarness();
    const t = (await h.ticket("view", "login")).body.ticket as string;
    const first = await h.stream(`${BASE}/events?ticket=${t}`);
    expect(first.status).toBe(200);
    first.close();
    const reuse = await h.stream(`${BASE}/events?ticket=${t}`);
    expect(reuse.status).toBe(401);

    const expiring = (await h.ticket("view", "login")).body.ticket as string;
    h.clock.at += 60_001;
    expect((await h.stream(`${BASE}/events?ticket=${expiring}`)).status).toBe(401);

    const other = (await h.ticket("view", "watch")).body.ticket as string;
    expect((await h.stream(`${BASE}/events?ticket=${other}`)).status).toBe(401);
    const spent = await h.stream(`/api/runs/run-1/stages/watch/live-view/events?ticket=${other}`);
    expect(spent.status).toBe(401);
  });

  it("a ticket for one owner scope cannot open another", async () => {
    const h = await startHarness({ scopeHeader: true });
    const t = (await h.ticket("view", "login", { "x-scope": "scope-a" })).body.ticket as string;
    const wrong = await h.stream(`${BASE}/events?ticket=${t}`, { "x-scope": "scope-b" });
    expect(wrong.status).toBe(401);
    const again = await h.stream(`${BASE}/events?ticket=${t}`, { "x-scope": "scope-a" });
    expect(again.status).toBe(401);

    const t2 = (await h.ticket("view", "login", { "x-scope": "scope-a" })).body.ticket as string;
    const right = await h.stream(`${BASE}/events?ticket=${t2}`, { "x-scope": "scope-a" });
    expect(right.status).toBe(200);
    right.close();
    expect(h.audit.records.find((r) => r.event === "live_view_opened")).toMatchObject({ scope: "scope-a" });
  });
});

describe("live view event stream", () => {
  it("sets a path-scoped cookie, replays first, then streams live and ends with closed", async () => {
    const h = await startHarness();
    const t = (await h.ticket("view", "login")).body.ticket as string;
    const pre = await h.stream(`${BASE}/events?ticket=${t}`);
    expect(pre.status).toBe(200);
    expect(pre.headers["content-type"]).toContain("text/event-stream");
    expect(pre.headers["cache-control"]).toBe("no-store");
    expect(pre.headers["x-frame-options"]).toBe("DENY");
    expect(pre.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    const cookie = String(pre.headers["set-cookie"]);
    expect(cookie).toMatch(/^sf_live_view=[^;]+/);
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");

    const session = h.fake.sessions[0]!;
    session.emit({ type: "status", data: { connected: true } });
    session.emit({ type: "frame", data: { data: "AAAA", width: 10, height: 20 } });
    await pre.waitFor("frame");
    pre.close();

    const late = await h.stream(`${BASE}/events`, { cookie: cookie.split(";")[0]! });
    expect(late.status).toBe(200);
    await late.waitFor("frame");
    expect(late.events.map((e) => e.event)).toEqual(["status", "frame"]);
    expect(JSON.parse(late.events[1]!.data)).toEqual({ data: "AAAA", width: 10, height: 20 });

    session.emit({ type: "tabs", data: [{ id: 1 }] });
    session.emit({ type: "url", data: { url: "https://x.example/" } });
    session.emit({ type: "retarget", data: { tab: 2 } });
    await late.waitFor("retarget");
    expect(late.events.map((e) => e.event)).toEqual(["status", "frame", "tabs", "url", "retarget"]);

    await session.close();
    await late.waitFor("closed");
    await vi.waitFor(() => expect(late.ended()).toBe(true));
    expect(h.opened).toHaveLength(1);
  });

  it("marks the cookie Secure behind an https proxy and never forwards console messages", async () => {
    const h = await startHarness();
    const t = (await h.ticket("view", "login")).body.ticket as string;
    const s = await h.stream(`${BASE}/events?ticket=${t}`, { "x-forwarded-proto": "https" });
    expect(String(s.headers["set-cookie"])).toContain("Secure");
    h.fake.sessions[0]!.emit({ type: "console" as never, data: { text: "page secret" } });
    h.fake.sessions[0]!.emit({ type: "url", data: { url: "u" } });
    await s.waitFor("url");
    expect(s.events.map((e) => e.event)).toEqual(["url"]);
    s.close();
  });

  it("rejects an event stream with neither ticket nor cookie, or a cookie for another stage", async () => {
    const h = await startHarness();
    expect((await h.stream(`${BASE}/events`)).status).toBe(401);
    const { cookie, stream } = await h.openControl("login");
    stream.close();
    const wrongStage = await h.stream(`/api/runs/run-1/stages/watch/live-view/events`, { cookie });
    expect(wrongStage.status).toBe(401);
    const bogus = await h.stream(`${BASE}/events`, { cookie: "sf_live_view=forged" });
    expect(bogus.status).toBe(401);
  });

  it("a fresh control ticket wins over an older view cookie; a spent ticket falls back to the cookie", async () => {
    const h = await startHarness();
    const viewTicket = (await h.ticket("view", "login")).body.ticket as string;
    const view = await h.stream(`${BASE}/events?ticket=${viewTicket}`);
    const viewCookie = String(view.headers["set-cookie"]).split(";")[0]!;

    const reconnect = await h.stream(`${BASE}/events?ticket=${viewTicket}`, { cookie: viewCookie });
    expect(reconnect.status).toBe(200);
    expect(reconnect.headers["set-cookie"]).toBeUndefined();
    reconnect.close();

    const control = (await h.ticket("control", "login")).body.ticket as string;
    const upgraded = await h.stream(`${BASE}/events?ticket=${control}`, { cookie: viewCookie });
    expect(upgraded.status).toBe(200);
    const controlCookie = String(upgraded.headers["set-cookie"]).split(";")[0]!;
    const sent = await h.post(`${BASE}/input`, [click], h.inputHeaders(controlCookie));
    expect(sent.status).toBe(200);
    view.close();
    upgraded.close();
  });

  it("sends a comment heartbeat on the injected timer", async () => {
    const h = await startHarness();
    const t = (await h.ticket("view", "login")).body.ticket as string;
    const s = await h.stream(`${BASE}/events?ticket=${t}`);
    h.beats.forEach((beat) => beat());
    await vi.waitFor(() => expect(s.raw()).toContain(": keepalive"));
    s.close();
  });

  it("shares one relay session between viewers and closes it after the grace period", async () => {
    const h = await startHarness();
    const a = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    const b = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    expect(h.fake.sessions).toHaveLength(1);

    a.close();
    await flush();
    expect(h.timers).toHaveLength(0);
    b.close();
    await vi.waitFor(() => expect(h.timers).toHaveLength(1));
    expect(h.fake.sessions[0]!.closed).toBe(false);
    h.timers[0]!.fn();
    expect(h.fake.sessions[0]!.closed).toBe(true);

    const c = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    expect(h.fake.sessions).toHaveLength(2);
    c.close();
  });

  it("a viewer returning within the grace period keeps the session", async () => {
    const h = await startHarness();
    const a = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    a.close();
    await vi.waitFor(() => expect(h.timers).toHaveLength(1));
    const b = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    expect(h.timers[0]!.cleared).toBe(true);
    h.timers[0]!.fn();
    expect(h.fake.sessions[0]!.closed).toBe(false);
    expect(h.fake.sessions).toHaveLength(1);
    b.close();
  });

  it("builds the relay from the persisted stage env and run anchor", async () => {
    const h = await startHarness();
    const s = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    expect(h.opened[0]).toMatchObject({
      runId: "run-1",
      stageId: "login",
      env: { AGENT_BROWSER_SESSION: "s-login" },
      anchorEnv: { A: "1" },
      cdpAddress: "ws://127.0.0.1:9222",
    });
    s.close();
    const w = await h.stream(`/api/runs/run-1/stages/watch/live-view/events?ticket=${(await h.ticket("view", "watch")).body.ticket}`);
    expect(h.opened[1]!.cdpAddress).toBeUndefined();
    w.close();
  });

  it("reports an unavailable relay as a conflict without leaking details", async () => {
    const h = await startHarness({
      relay: {
        open: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:4999");
        },
      },
    });
    const s = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    expect(s.status).toBe(409);
  });
});

describe("live view input", () => {
  it("requires the cookie, the anti-forgery header and an allowed Origin", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    expect((await h.post(`${BASE}/input`, [click], { origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(401);
    expect((await h.post(`${BASE}/input`, [click], { cookie: "sf_live_view=forged", origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(401);
    expect((await h.post(`${BASE}/input`, [click], { cookie, origin: h.origin })).status).toBe(403);
    expect((await h.post(`${BASE}/input`, [click], { cookie, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(403);
    expect((await h.post(`${BASE}/input`, [click], { cookie, origin: "https://evil.example", [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(403);
    expect(h.fake.sessions[0]!.input).toEqual([]);
    expect((await h.post(`${BASE}/input`, [click], h.inputHeaders(cookie))).status).toBe(200);
  });

  it("forbids input for view sessions", async () => {
    const h = await startHarness();
    const s = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    const cookie = String(s.headers["set-cookie"]).split(";")[0]!;
    const res = await h.post(`${BASE}/input`, [click], h.inputHeaders(cookie));
    expect(res.status).toBe(403);
    expect(h.fake.sessions[0]!.input).toEqual([]);
    s.close();
  });

  it("maps relay results to statuses and keeps order across posts", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    const a = { ...click, x: 1 };
    const b = { ...click, x: 2 };
    const c = { ...click, x: 3 };
    expect((await h.post(`${BASE}/input`, [a, b], headers)).body).toEqual({ accepted: 2 });
    expect((await h.post(`${BASE}/input`, [c], headers)).status).toBe(200);
    expect(h.fake.sessions[0]!.input.map((e) => e.x)).toEqual([1, 2, 3]);

    const session = h.fake.sessions[0]!;
    const results = {
      batch_too_large: 413,
      rate_limited: 429,
      invalid_event: 400,
      not_array: 400,
      closed: 409,
      upstream_unavailable: 409,
    } as const;
    for (const [reason, status] of Object.entries(results)) {
      session.sendInput = async () => ({ ok: false, reason: reason as keyof typeof results });
      const res = await h.post(`${BASE}/input`, [a], headers);
      expect(res.status, reason).toBe(status);
    }
  });

  it("rejects malformed and oversized bodies without echoing them", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    expect((await h.post(`${BASE}/input`, "{not json", headers, true)).status).toBe(400);
    const big = JSON.stringify([{ ...click, text: "x".repeat(LIVE_VIEW_MAX_INPUT_BYTES) }]);
    const res = await h.post(`${BASE}/input`, big, headers, true);
    expect(res.status).toBe(413);
    expect(res.text).not.toContain("xxxx");
    expect(h.fake.sessions[0]!.input).toEqual([]);
  });

  it("returns closed when no relay session is open", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const session = h.fake.sessions[0]!;
    await session.close();
    await stream.waitFor("closed");
    const res = await h.post(`${BASE}/input`, [click], h.inputHeaders(cookie));
    expect(res.status).toBe(409);
  });
});

describe("live view reopen tab", () => {
  it("requires the cookie, the anti-forgery header and an allowed Origin", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const url = `${BASE}/reopen-tab`;
    expect((await h.post(url, "", { origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" }, true)).status).toBe(401);
    expect((await h.post(url, "", { cookie: "sf_live_view=forged", origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" }, true)).status).toBe(401);
    expect((await h.post(url, "", { cookie, origin: h.origin }, true)).status).toBe(403);
    expect((await h.post(url, "", { cookie, [LIVE_VIEW_CSRF_HEADER]: "1" }, true)).status).toBe(403);
    expect((await h.post(url, "", { cookie, origin: "https://evil.example", [LIVE_VIEW_CSRF_HEADER]: "1" }, true)).status).toBe(403);
    expect(h.fake.sessions[0]!.reopens).toBe(0);
    const ok = await h.post(url, "", h.inputHeaders(cookie), true);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(h.fake.sessions[0]!.reopens).toBe(1);
  });

  it("forbids reopening for view sessions", async () => {
    const h = await startHarness();
    const s = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    const cookie = String(s.headers["set-cookie"]).split(";")[0]!;
    expect((await h.post(`${BASE}/reopen-tab`, "", h.inputHeaders(cookie), true)).status).toBe(403);
    expect(h.fake.sessions[0]!.reopens).toBe(0);
    s.close();
  });

  it("maps relay results to statuses and rejects oversized bodies", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    const session = h.fake.sessions[0]!;
    const expected = {
      closed: 409,
      no_tab: 409,
      upstream_unavailable: 409,
      rate_limited: 429,
      failed: 502,
    } as const;
    for (const [reason, status] of Object.entries(expected)) {
      session.reopenResult = { ok: false, reason: reason as keyof typeof expected };
      const res = await h.post(`${BASE}/reopen-tab`, "", headers, true);
      expect(res.status, reason).toBe(status);
      expect(res.body.code).toBe(reason);
    }
    const big = await h.post(`${BASE}/reopen-tab`, "x".repeat(4096), headers, true);
    expect(big.status).toBe(413);
    expect((await h.post(`${BASE}/reopen-tab`, "{nope", headers, true)).status).toBe(400);
  });

  it("returns closed when the relay session is gone", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    await h.fake.sessions[0]!.close();
    await stream.waitFor("closed");
    expect((await h.post(`${BASE}/reopen-tab`, "", h.inputHeaders(cookie), true)).status).toBe(409);
  });
});

describe("live view page dialogs", () => {
  const confirmDialog = { id: "d1", kind: "confirm", message: "Sure?", defaultPrompt: "", targetId: "t1", answerable: true };
  const alertDialog = { id: "d2", kind: "alert", message: "Hi", defaultPrompt: "", targetId: "t1", answerable: false };

  it("streams dialog and dialog_closed events and replays an open dialog to a late viewer", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const session = h.fake.sessions[0]!;
    session.emit({ type: "status", data: { connected: true } });
    session.emit({ type: "dialog", data: confirmDialog });
    await stream.waitFor("dialog");
    expect(JSON.parse(stream.events.find((e) => e.event === "dialog")!.data)).toEqual(confirmDialog);
    const late = await h.stream(`${BASE}/events`, { cookie });
    await late.waitFor("dialog");
    expect(late.events.map((e) => e.event)).toEqual(["status", "dialog"]);
    session.emit({ type: "dialog_closed", data: { id: "d1", result: "timeout" } });
    await stream.waitFor("dialog_closed");
    expect(JSON.parse(stream.events.at(-1)!.data)).toEqual({ id: "d1", result: "timeout" });
    late.close();
  });

  it("requires the cookie, the anti-forgery header and an allowed Origin", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    h.fake.sessions[0]!.emit({ type: "dialog", data: confirmDialog });
    const body = { id: "d1", accept: true };
    expect((await h.post(`${BASE}/dialog`, body, { origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(401);
    expect((await h.post(`${BASE}/dialog`, body, { cookie: "sf_live_view=forged", origin: h.origin, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(401);
    expect((await h.post(`${BASE}/dialog`, body, { cookie, origin: h.origin })).status).toBe(403);
    expect((await h.post(`${BASE}/dialog`, body, { cookie, [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(403);
    expect((await h.post(`${BASE}/dialog`, body, { cookie, origin: "https://evil.example", [LIVE_VIEW_CSRF_HEADER]: "1" })).status).toBe(403);
    expect(h.fake.sessions[0]!.answers).toEqual([]);
    expect((await h.post(`${BASE}/dialog`, body, h.inputHeaders(cookie))).status).toBe(200);
    expect(h.fake.sessions[0]!.answers).toEqual([body]);
  });

  it("forbids answers for view sessions", async () => {
    const h = await startHarness();
    const s = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    const cookie = String(s.headers["set-cookie"]).split(";")[0]!;
    h.fake.sessions[0]!.emit({ type: "dialog", data: confirmDialog });
    const res = await h.post(`${BASE}/dialog`, { id: "d1", accept: true }, h.inputHeaders(cookie));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("view_only");
    expect(h.fake.sessions[0]!.answers).toEqual([]);
    s.close();
  });

  it("maps relay results to statuses; one answer per dialog", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    const session = h.fake.sessions[0]!;
    session.emit({ type: "dialog", data: confirmDialog });
    session.emit({ type: "dialog", data: alertDialog });
    const prompt = await h.post(`${BASE}/dialog`, { id: "d1", accept: true, promptText: "x" }, headers);
    expect(prompt.status).toBe(200);
    const again = await h.post(`${BASE}/dialog`, { id: "d1", accept: false }, headers);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("no_dialog");
    expect((await h.post(`${BASE}/dialog`, { id: "nope", accept: false }, headers)).status).toBe(409);
    const readOnly = await h.post(`${BASE}/dialog`, { id: "d2", accept: true }, headers);
    expect(readOnly.status).toBe(400);
    expect(readOnly.body.code).toBe("not_answerable");
    expect(session.answers).toHaveLength(1);
    session.answerDialog = async () => ({ ok: false, reason: "closed" });
    expect((await h.post(`${BASE}/dialog`, { id: "d1", accept: true }, headers)).status).toBe(409);
  });

  it("validates the body and rejects oversized or malformed ones without echoing them", async () => {
    const h = await startHarness();
    const { cookie } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    expect((await h.post(`${BASE}/dialog`, "{not json", headers, true)).status).toBe(400);
    expect((await h.post(`${BASE}/dialog`, [1], headers)).status).toBe(400);
    expect((await h.post(`${BASE}/dialog`, { id: 1, accept: true }, headers)).status).toBe(400);
    expect((await h.post(`${BASE}/dialog`, { id: "d1", accept: "yes" }, headers)).status).toBe(400);
    expect((await h.post(`${BASE}/dialog`, { id: "d1", accept: true, promptText: 5 }, headers)).status).toBe(400);
    const big = JSON.stringify({ id: "d1", accept: true, promptText: "x".repeat(LIVE_VIEW_MAX_DIALOG_BYTES) });
    const res = await h.post(`${BASE}/dialog`, big, headers, true);
    expect(res.status).toBe(413);
    expect(res.text).not.toContain("xxxx");
    expect(h.fake.sessions[0]!.answers).toEqual([]);
  });

  it("returns closed when no relay session is open and rejects after revocation", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    h.fake.sessions[0]!.emit({ type: "dialog", data: confirmDialog });
    h.fire("run-1", "login");
    await stream.waitFor("closed");
    expect((await h.post(`${BASE}/dialog`, { id: "d1", accept: true }, headers)).status).toBe(401);
    expect(h.fake.sessions[0]!.answers).toEqual([]);
  });

  it("keeps dialog text out of logs, audit and responses", async () => {
    const sentinel = "SENTINEL-dlg-9d2e";
    const captured: string[] = [];
    const grab = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return true;
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(grab);
    }
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => grab(chunk)) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => grab(chunk)) as never);
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    h.fake.sessions[0]!.emit({ type: "dialog", data: { ...confirmDialog, kind: "prompt", message: sentinel } });
    const responses = [
      await h.post(`${BASE}/dialog`, { id: "d1", accept: true, promptText: sentinel }, headers),
      await h.post(`${BASE}/dialog`, `{"promptText":"${sentinel}"`, headers, true),
    ];
    h.fake.sessions[0]!.answerDialog = async () => {
      throw new Error("boom");
    };
    responses.push(await h.post(`${BASE}/dialog`, { id: "d1", accept: true, promptText: sentinel }, headers));
    await flush();
    stream.close();
    await vi.waitFor(() => expect(h.audit.records).toHaveLength(2));
    const everything = JSON.stringify({ captured, audit: h.audit.records, responses: responses.map((r) => r.text), store: h.storeEvents });
    expect(everything).not.toContain(sentinel);
  });
});

describe("live view revocation and audit", () => {
  it("answering or abandoning a gate ends the control stream with closed and rejects input", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const pendingTicket = (await h.ticket("control")).body.ticket as string;

    h.fire("run-1", "login");
    await stream.waitFor("closed");
    expect(JSON.parse(stream.events.at(-1)!.data)).toEqual({ reason: "revoked" });
    expect((await h.post(`${BASE}/input`, [click], h.inputHeaders(cookie))).status).toBe(401);
    expect((await h.stream(`${BASE}/events?ticket=${pendingTicket}`)).status).toBe(401);
    expect((await h.stream(`${BASE}/events`, { cookie })).status).toBe(401);
    await vi.waitFor(() => expect(h.fake.sessions[0]!.closed).toBe(true));
  });

  it("closing a gate leaves a read-only watcher of the running stage watching until the stage ends", async () => {
    const h = await startHarness();
    const { stream } = await h.openControl();
    const watcher = await h.stream(`${BASE}/events?ticket=${(await h.ticket("view")).body.ticket}`);
    const watcherCookie = String(watcher.headers["set-cookie"]).split(";")[0]!;

    h.fire("run-1", "login");
    await stream.waitFor("closed");
    await flush();
    expect(h.fake.sessions[0]!.closed).toBe(false);
    expect((await h.stream(`${BASE}/events`, { cookie: watcherCookie })).status).toBe(200);
    h.fake.sessions[0]!.emit({ type: "retarget", data: { tab: "t2", url: "https://popup.example/" } } as never);
    await vi.waitFor(() => expect(watcher.events.some((e) => e.event === "retarget")).toBe(true));

    await h.teardown("run-1", "login");
    await watcher.waitFor("closed");
    expect(h.fake.sessions[0]!.closed).toBe(true);
  });

  it("cancelling the run revokes every stage", async () => {
    const h = await startHarness();
    const login = await h.openControl("login");
    const watch = await h.stream(`/api/runs/run-1/stages/watch/live-view/events?ticket=${(await h.ticket("view", "watch")).body.ticket}`);
    h.fire("run-1");
    await login.stream.waitFor("closed");
    await watch.waitFor("closed");
    expect(h.fake.sessions.every((s) => s.closed)).toBe(true);
  });

  it("other runs are unaffected", async () => {
    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    h.fire("run-2");
    h.fire("run-1", "watch");
    await flush();
    expect((await h.post(`${BASE}/input`, [click], h.inputHeaders(cookie))).status).toBe(200);
    stream.close();
  });

  it("writes opened and closed audit records with ids, mode and caller only", async () => {
    const h = await startHarness({ tokens: true });
    const t = await h.ticket("control", "login", { authorization: `Bearer ${DRIVE}` });
    const s = await h.stream(`${BASE}/events?ticket=${t.body.ticket}`);
    await vi.waitFor(() => expect(h.audit.records).toHaveLength(1));
    s.close();
    await vi.waitFor(() => expect(h.audit.records).toHaveLength(2));
    expect(h.audit.records).toEqual([
      { event: "live_view_opened", scope: "local", runId: "run-1", stageId: "login", mode: "control", callerId: "default" },
      { event: "live_view_closed", scope: "local", runId: "run-1", stageId: "login", mode: "control", callerId: "default" },
    ]);
  });
});

describe("live view no-logging guarantee", () => {
  it("keeps input bodies and frames out of logs, audit, errors and run store events", async () => {
    const sentinel = "SENTINEL-7f3a9c-do-not-log";
    const captured: string[] = [];
    const grab = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return true;
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(grab);
    }
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => grab(chunk)) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => grab(chunk)) as never);

    const h = await startHarness();
    const { cookie, stream } = await h.openControl();
    const headers = h.inputHeaders(cookie);
    const responses = [
      await h.post(`${BASE}/input`, [{ ...click, text: sentinel }], headers),
      await h.post(`${BASE}/input`, `[{"text":"${sentinel}"`, headers, true),
      await h.post(`${BASE}/input`, { text: sentinel }, headers),
      await h.post(`${BASE}/input`, [{ ...click, text: sentinel.repeat(LIVE_VIEW_MAX_INPUT_BYTES) }], headers),
    ];
    h.fake.sessions[0]!.sendInput = async () => {
      throw new Error("boom");
    };
    responses.push(await h.post(`${BASE}/input`, [{ ...click, text: sentinel }], headers));
    h.fake.sessions[0]!.emit({ type: "frame", data: { data: sentinel } });
    await flush();
    stream.close();
    await vi.waitFor(() => expect(h.audit.records).toHaveLength(2));
    h.fire("run-1", "login");
    await flush();

    expect(responses[0]!.status).toBe(200);
    const everything = JSON.stringify({
      captured,
      audit: h.audit.records,
      responses: responses.map((r) => ({ status: r.status, text: r.text })),
      storeEvents: h.storeEvents,
    });
    expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain("SENTINEL-7f3a9c");
  });
});

describe("live view lifecycle", () => {
  const eventsUrl = (stage: string, ticket: unknown) =>
    `/api/runs/run-1/stages/${stage}/live-view/events?ticket=${ticket}`;

  async function expectNothingLeft(h: Harness, cookies: string[]) {
    await vi.waitFor(() => expect(h.fake.sessions.every((s) => s.closed)).toBe(true));
    expect(h.pendingTimers()).toBe(0);
    expect(h.liveBeats()).toBe(0);
    for (const cookie of cookies) {
      expect((await h.stream(`${BASE}/events`, { cookie })).status).toBe(401);
    }
  }

  it("closes the stage relay and credentials before teardown continues, with a final closed event", async () => {
    const h = await startHarness();
    const { stream, cookie } = await h.openControl();
    const watch = await h.stream(eventsUrl("watch", (await h.ticket("view", "watch")).body.ticket));
    await h.teardown("run-1", "login");
    expect(h.fake.sessions[0]!.closed).toBe(true);
    expect(h.fake.sessions[1]!.closed).toBe(false);
    await stream.waitFor("closed");
    expect(JSON.parse(stream.events.at(-1)!.data)).toEqual({ reason: "revoked" });
    expect((await h.stream(`${BASE}/events`, { cookie })).status).toBe(401);
    expect(h.liveBeats()).toBe(1);
    await h.teardown("run-1");
    await watch.waitFor("closed");
    await expectNothingLeft(h, [cookie]);
  });

  it("waits for a close already started by the gate listener before teardown continues", async () => {
    const h = await startHarness();
    const { stream } = await h.openControl();
    const session = h.fake.sessions[0]!;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realClose = session.close;
    session.close = async () => {
      await gate;
      await realClose();
    };
    h.fire("run-1", "login");
    let done = false;
    const tearingDown = h.teardown("run-1", "login").then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    release();
    await tearingDown;
    expect(session.closed).toBe(true);
    await stream.waitFor("closed");
  });

  it("leaves no timers or relay sessions when the last viewer leaves and the stage then ends", async () => {
    const h = await startHarness();
    const a = await h.stream(eventsUrl("watch", (await h.ticket("view", "watch")).body.ticket));
    a.close();
    await vi.waitFor(() => expect(h.pendingTimers()).toBe(1));
    await h.teardown("run-1", "watch");
    await expectNothingLeft(h, []);
  });

  it("disposes streams, credentials, timers and sessions on server shutdown", async () => {
    const h = await startHarness();
    const control = await h.openControl();
    const watch = await h.stream(eventsUrl("watch", (await h.ticket("view", "watch")).body.ticket));
    const gone = await h.stream(eventsUrl("local", (await h.ticket("view", "local")).body.ticket));
    gone.close();
    await vi.waitFor(() => expect(h.pendingTimers()).toBe(1));
    h.shutdown();
    await control.stream.waitFor("closed");
    await watch.waitFor("closed");
    await h.routes.dispose();
    await expectNothingLeft(h, [control.cookie]);
    expect(control.stream.ended()).toBe(true);
    expect(watch.ended()).toBe(true);
    expect((await h.ticket("view", "watch")).status).toBe(200);
  });

  it("rebuilds the relay after a Host restart from persisted state alone", async () => {
    const first = await startHarness();
    const old = await first.openControl();
    await first.routes.dispose();
    await old.stream.waitFor("closed");
    expect(first.fake.sessions[0]!.closed).toBe(true);

    const second = await startHarness({ root: first.root });
    expect(second.fake.sessions).toHaveLength(0);
    const ticket = await second.ticket("control");
    expect(ticket.status).toBe(200);
    const stream = await second.stream(eventsUrl("login", ticket.body.ticket));
    expect(stream.status).toBe(200);
    await vi.waitFor(() => expect(second.opened).toHaveLength(1));
    expect(second.opened[0]).toMatchObject({
      runId: "run-1",
      stageId: "login",
      env: { AGENT_BROWSER_SESSION: "s-login" },
      anchorEnv: { A: "1" },
      cdpAddress: "ws://127.0.0.1:9222",
    });
    second.fake.sessions[0]!.emit({ type: "frame", data: { data: "AAAA" } });
    await stream.waitFor("frame");
    const late = await second.stream(eventsUrl("login", (await second.ticket("view")).body.ticket));
    await late.waitFor("frame");
    late.close();
    stream.close();
  });
});
