import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRunProfileBrowser } from "../src/browser/anchor.js";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import { sweepOrphanBrowserSessions } from "../src/browser/browserSweep.js";
import { teardownRunBrowsers } from "../src/browser/browserTeardown.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createContainerBrowserHost } from "../src/browser/containerBrowserHost.js";
import { sandboxIdFromLabels } from "../src/browser/liveViewSource.js";
import { createLiveViewTicketService } from "../src/browser/liveViewTickets.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { SandboxError } from "../src/browser/sandboxOrchestrator.js";
import {
  createSessionApiSandboxOrchestrator,
  type SessionApiClient,
} from "../src/browser/sessionApiSandboxOrchestrator.js";
import { resolveStageHandoffCapabilities } from "../src/browser/stageHandoff.js";
import { resolveStageBrowserEnv } from "../src/browser/stageBrowserEnv.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import type { RunStore } from "../src/runstore/port.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { createLiveViewRoutes } from "../src/server/liveViewRoutes.js";
import { FAKE_PROVIDER_VIEW_ORIGIN, createFakeProviderSession } from "./helpers/fakeProviderSession.js";

const API_KEY = "pk_live_PROVIDER_SECRET_0123456789";
const runner: BrowserRunner = async () => ({ code: 0, stdout: "" });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join("/tmp", "sfpn-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

function setup(
  options: {
    liveView?: "relay" | "provider_view" | "none";
    viewerInput?: "interactive" | "view_only";
    provider?: ReturnType<typeof createFakeProviderSession>;
  } = {},
) {
  const provider = options.provider ?? createFakeProviderSession({ apiKey: API_KEY, presentedKey: API_KEY });
  const orchestrator = createSessionApiSandboxOrchestrator({ client: provider.api });
  const host = createContainerBrowserHost({
    orchestrator,
    endpoint: provider.endpoint,
    liveView: options.liveView ?? "none",
    ...(options.viewerInput !== undefined ? { capabilities: { viewerInput: options.viewerInput } } : {}),
    local: { platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") },
    pollMs: 1,
    closeWaitMs: 30,
    startTimeoutMs: 30,
  });
  const profiles = createVolumeProfileStore();
  const support: StageBrowserSupport = {
    host,
    profiles,
    runner,
    socketRoot: path.join(root, "sock"),
    locks: createInMemoryProfileLock(),
    closeWaitMs: 50,
    blockedSites: [],
    audit: createMemoryAuditSink(),
  };
  return { provider, orchestrator, host, profiles, support };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

async function allText(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of await filesUnder(dir)) parts.push(await readFile(file, "utf8").catch(() => ""));
  return parts.join("\n");
}

describe("a provider-style adapter behind the same ports", () => {
  it("runs the container host lifecycle through a session API: start, adopt, teardown, sweep", async () => {
    const { provider, orchestrator, host, support, profiles } = setup();
    const profile = await profiles.open({ scope: "local", name: "acct" });
    const runDir = path.join(root, "run");
    const input = { runId: "run-1", runDir, browser: { profile: "acct" }, profile };
    const first = await ensureRunProfileBrowser(support, input);
    expect(first.cdpAddress).toBe(provider.addressOf(1));
    expect(provider.calls).toContain("create:local/acct");
    const again = await ensureRunProfileBrowser(support, input);
    expect(again.cdpAddress).toBe(first.cdpAddress);
    expect(await orchestrator.listByLabel({})).toHaveLength(1);

    await teardownRunBrowsers(support, { runId: "run-1", runDir });
    expect(provider.events).toEqual(["close:1"]);
    expect(provider.sessions.size).toBe(0);

    for (const runId of ["run-dead", "run-live"]) {
      await ensureRunProfileBrowser(support, { ...input, runId, runDir: path.join(root, runId) });
    }
    const swept = await sweepOrphanBrowserSessions({
      isRunLive: async (runId) => runId === "run-live",
      host,
      runner,
      closeWaitMs: 50,
      socketRoot: path.join(root, "sock"),
    });
    expect(swept.released).toEqual(["psess_2"]);
    expect([...provider.sessions.values()].map((s) => s.metadata["stageflow.run"])).toEqual(["run-live"]);
  });

  it("never touches a provider session Stageflow did not label", async () => {
    const { provider, orchestrator } = setup();
    provider.sessions.set("psess_foreign", {
      id: "psess_foreign",
      state: "active",
      connect_url: "ws://10.9.9.9:9222/x",
      region: "x",
      metadata: { owner: "someone-else" },
    });
    expect(await orchestrator.listByLabel({})).toEqual([]);
  });

  it("keeps provider data in the single opaque ref field and maps provider failures to port errors", async () => {
    const { provider, orchestrator } = setup();
    const info = await orchestrator.start({ labels: { scope: "local", runId: "r1" } });
    expect(Object.keys(info)).toEqual(["ref", "labels", "status", "attachAddress"]);
    expect(info.ref.adapter).toEqual({ id: "session-api", version: 1, data: { region: "test-1" } });
    provider.failNext("quota_exceeded");
    await expect(orchestrator.start({ labels: { scope: "local", runId: "r1" } })).rejects.toMatchObject({
      errorClass: "out_of_capacity",
    });
    provider.failNext("unauthorized");
    await expect(orchestrator.start({ labels: { scope: "local", runId: "r1" } })).rejects.toMatchObject({
      errorClass: "not_authorized",
    });
    provider.failNext("unavailable");
    await expect(orchestrator.start({ labels: { scope: "local", runId: "r1" } })).rejects.toMatchObject({
      errorClass: "unavailable",
    });
    await expect(
      orchestrator.start({ labels: { scope: "local", runId: "r1" }, egress: { allowDomains: ["a.example"] } }),
    ).rejects.toBeInstanceOf(SandboxError);
  });
});

describe("capability preconditions at stage start", () => {
  it("fails a human login stage on a view-only provider viewer, naming the missing capability", async () => {
    const { support } = setup({ liveView: "provider_view", viewerInput: "view_only" });
    await expect(
      resolveStageBrowserEnv(support, {
        runId: "run-1",
        stageId: "login",
        scope: "local",
        runDir: path.join(root, "run"),
        browser: { profile: "acct", login_url: "https://login.example/" },
        humanLogin: true,
      }),
    ).rejects.toThrow(/viewer_input: interactive/);
    expect(() => resolveStageHandoffCapabilities(support, { humanLogin: true })).toThrow(/view-only/);
  });

  it("accepts the same login stage when the viewer is interactive, and a view-only viewer for a non-login stage", () => {
    const interactive = setup({ liveView: "provider_view", viewerInput: "interactive" });
    expect(resolveStageHandoffCapabilities(interactive.support, { humanLogin: true })).toEqual({
      display: "virtual_display",
      liveView: "provider_view",
    });
    const viewOnly = setup({ liveView: "provider_view", viewerInput: "view_only" });
    expect(resolveStageHandoffCapabilities(viewOnly.support)).toEqual({
      display: "virtual_display",
      liveView: "provider_view",
    });
  });
});

describe("provider_view through the live view route", () => {
  const RUN = "run-1";
  const STAGE = "login";
  const BASE = `/api/runs/${RUN}/stages/${STAGE}/live-view`;
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(liveView: "provider_view" | "relay") {
    const env = setup({ liveView, viewerInput: "interactive" });
    const runDir = path.join(root, RUN);
    await mkdir(runDir, { recursive: true });
    const clock = { at: 1_000_000 };
    await resolveStageBrowserEnv(env.support, {
      runId: RUN,
      stageId: STAGE,
      scope: "local",
      runDir,
      browser: { profile: "acct", login_url: "https://login.example/" },
      humanLogin: true,
    });
    const source = env.provider.viewerSource({ now: () => clock.at });
    const audit = createMemoryAuditSink();
    const storeEvents: unknown[] = [];
    const store = {
      readRun: async () => ({
        stages: [
          {
            stage_id: STAGE,
            status: "waiting_for_input",
            pending_prompt: { kind: "confirm", id: "p1", message: "log in", profile: "acct", handoff: { kind: "live_view", url: BASE } },
          },
        ],
      }),
      getWorkspaceDir: () => runDir,
      appendStageEvent: async (...args: unknown[]) => void storeEvents.push(args),
    } as unknown as RunStore;
    const tickets = createLiveViewTicketService({ now: () => clock.at });
    const routes = createLiveViewRoutes({
      store,
      controlTokens: loadControlTokens({}),
      tickets,
      audit,
      now: () => clock.at,
      viewer: { source, sandboxIdOf: sandboxIdFromLabels(env.orchestrator) },
    });
    server = createServer(async (req, res) => {
      if (!(await routes.handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const issue = (mode: "view" | "control" = "view", stage = STAGE) =>
      tickets.issue({ scope: "local", runId: RUN, stageId: stage, mode, callerId: null }).ticket;
    const get = async (pathname: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`${origin}${pathname}`, { headers });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, string>) : {} };
    };
    return { ...env, runDir, clock, source, audit, storeEvents, tickets, routes, issue, get };
  }

  it("returns a short-lived provider address and the embed origin for a valid ticket", async () => {
    const h = await start("provider_view");
    const res = await h.get(`${BASE}/viewer?ticket=${h.issue()}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`^${FAKE_PROVIDER_VIEW_ORIGIN}/live/psess_1\\?access_token=`));
    expect(res.body.embed_origin).toBe(FAKE_PROVIDER_VIEW_ORIGIN);
    expect(Date.parse(res.body.expires_at!)).toBe(h.clock.at + 60_000);
    expect(res.headers.get("set-cookie")).toMatch(/sf_live_view=.*Path=\/api\/runs\/run-1\/stages\/login\/live-view/);
  });

  it("asks the source again on every request: addresses are per-session, never cached", async () => {
    const h = await start("provider_view");
    const first = await h.get(`${BASE}/viewer?ticket=${h.issue()}`);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const second = await h.get(`${BASE}/viewer`, { cookie });
    expect(second.status).toBe(200);
    expect(second.body.url).not.toBe(first.body.url);
    expect(h.source.issued).toHaveLength(2);
  });

  it("refuses without a valid ticket, with a reused ticket, for another stage, and after revocation", async () => {
    const h = await start("provider_view");
    expect((await h.get(`${BASE}/viewer`)).status).toBe(401);
    const ticket = h.issue();
    expect((await h.get(`${BASE}/viewer?ticket=${ticket}`)).status).toBe(200);
    expect((await h.get(`${BASE}/viewer?ticket=${ticket}`)).status).toBe(401);
    const other = h.issue("view", "other");
    expect((await h.get(`${BASE}/viewer?ticket=${other}`)).status).toBe(401);
    const cookie = (await h.get(`${BASE}/viewer?ticket=${h.issue()}`)).headers.get("set-cookie")!.split(";")[0]!;
    h.tickets.revoke(RUN, STAGE);
    expect((await h.get(`${BASE}/viewer`, { cookie })).status).toBe(401);
  });

  it("answers no_provider_view when the stage's live view is the relay", async () => {
    const h = await start("relay");
    const res = await h.get(`${BASE}/viewer?ticket=${h.issue()}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_provider_view");
    expect(h.source.issued).toEqual([]);
  });

  it("answers no_browser once the provider session is gone", async () => {
    const h = await start("provider_view");
    h.provider.sessions.clear();
    const res = await h.get(`${BASE}/viewer?ticket=${h.issue()}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_browser");
  });

  it("never stores the address in a gate, run file, audit record, store event or log", async () => {
    const h = await start("provider_view");
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const res = await h.get(`${BASE}/viewer?ticket=${h.issue()}`);
    const token = new URL(res.body.url!).searchParams.get("access_token")!;
    expect(token.length).toBeGreaterThan(6);
    const written = [
      await allText(h.runDir),
      await allText(process.env.STAGEFLOW_HOME!),
      JSON.stringify(h.audit.records),
      JSON.stringify(h.storeEvents),
      JSON.stringify([...logs, stdout, stderr].map((spy) => spy.mock.calls)),
    ].join("\n");
    expect(written).not.toContain(token);
    expect(written).not.toContain(FAKE_PROVIDER_VIEW_ORIGIN);
    expect(h.audit.records.map((r) => r.event)).toEqual(["live_view_opened"]);
    expect(h.routes).toBeDefined();
  });

  it("keeps provider credentials out of stage environments, run files, audit records and logs", async () => {
    const h = await start("provider_view");
    const env = await resolveStageBrowserEnv(h.support, {
      runId: RUN,
      stageId: "watch",
      scope: "local",
      runDir: h.runDir,
      browser: { profile: "acct" },
    });
    const everything = [
      JSON.stringify(env),
      await allText(h.runDir),
      await allText(process.env.STAGEFLOW_HOME!),
      JSON.stringify(h.audit.records),
      JSON.stringify(h.provider.calls),
      JSON.stringify(h.provider.events),
    ].join("\n");
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain("PROVIDER_SECRET");
  });

  it("does not leak the credential through a failed start either", async () => {
    const provider = createFakeProviderSession({ apiKey: API_KEY, presentedKey: "pk_live_WRONG" });
    const { support } = setup({ provider });
    let message = "";
    try {
      await resolveStageBrowserEnv(support, {
        runId: RUN,
        stageId: "watch",
        scope: "local",
        runDir: path.join(root, RUN),
        browser: { profile: "acct" },
      });
    } catch (err) {
      message = String(err instanceof Error ? err.message : err);
    }
    expect(message).toMatch(/invalid credentials/);
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("WRONG");
  });
});

describe("structural: no provider names or SDKs in core modules", () => {
  const SRC = path.resolve(__dirname, "../src");
  const ADAPTER_MODULES = new Set([
    "browser/dockerSandboxOrchestrator.ts",
    "browser/sessionApiSandboxOrchestrator.ts",
  ]);
  /** Selects the adapter from Host config; the only core module allowed to import an adapter. */
  const COMPOSITION_ROOT = "browser/stageBrowserEnv.ts";
  const PROVIDER_NAMES =
    /browserbase|hyperbrowser|anchorbrowser|onkernel|kernel\.sh|steel\.dev|steel-sdk|cloudflare|\be2b\b|daytona|dockerode|testcontainers/i;

  async function coreModules(): Promise<Array<{ rel: string; text: string }>> {
    const files = (await filesUnder(SRC)).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const out: Array<{ rel: string; text: string }> = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (!ADAPTER_MODULES.has(rel)) out.push({ rel, text: await readFile(file, "utf8") });
    }
    return out;
  }

  const specifiers = (text: string) =>
    [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);

  it("finds the adapter modules it exempts", async () => {
    const all = new Set((await filesUnder(SRC)).map((f) => path.relative(SRC, f).split(path.sep).join("/")));
    for (const adapter of ADAPTER_MODULES) expect(all.has(adapter)).toBe(true);
    expect(all.has(COMPOSITION_ROOT)).toBe(true);
  });

  it("names no provider outside adapter modules", async () => {
    const hits = (await coreModules()).filter((m) => PROVIDER_NAMES.test(m.text)).map((m) => m.rel);
    expect(hits).toEqual([]);
  });

  it("imports no SDK or network client into the browser ports and hosts", async () => {
    const allowed = /^(node:[a-z/_]+|\.{1,2}\/.*)$/;
    const offenders = (await coreModules())
      .filter((m) => m.rel.startsWith("browser/"))
      .flatMap((m) => specifiers(m.text).filter((s) => !allowed.test(s)).map((s) => `${m.rel}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it("imports adapter modules only from the composition root", async () => {
    const adapterImport = /(dockerSandboxOrchestrator|sessionApiSandboxOrchestrator)\.js/;
    const hits = (await coreModules())
      .filter((m) => m.rel !== COMPOSITION_ROOT)
      .filter((m) => specifiers(m.text).some((s) => adapterImport.test(s)))
      .map((m) => m.rel);
    expect(hits).toEqual([]);
  });

  it("detects a violation (self-check of the scanner)", () => {
    expect(PROVIDER_NAMES.test('import { Browserbase } from "@browserbasehq/sdk"')).toBe(true);
    expect(specifiers('import x from "@acme/sdk";\nconst y = await import("left-pad")')).toEqual(["@acme/sdk", "left-pad"]);
  });
});
