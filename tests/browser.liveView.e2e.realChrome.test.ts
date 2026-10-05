import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent, type FakeAgentBehavior } from "../src/agent/fakeAgent.js";
import { runStageViaOpen, type AgentPort } from "../src/agent/port.js";
import type { BrowserEnv, BrowserHost, StageBrowserSupport } from "../src/browser/browserHost.js";
import { teardownRunBrowsers } from "../src/browser/browserTeardown.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const enabled = process.env.STAGEFLOW_BROWSER_SMOKE === "1";

const page = (body: string) =>
  `<!doctype html><meta charset=utf-8><body style="margin:0;font:20px system-ui">${body}`;
const field = (id: string, top: number, type = "text") =>
  `<input id=${id} name=${id} type=${type} style="position:absolute;left:40px;top:${top}px;width:300px;height:40px;font-size:20px">`;
const submit = (top: number) =>
  `<button type=submit style="position:absolute;left:40px;top:${top}px;width:300px;height:44px">Continue</button>`;

const PAGES: Record<string, string> = {
  "/login": page(
    `<form method=post action=/login>${field("user", 40)}${field("pass", 100, "password")}${submit(160)}</form>`,
  ),
  "/2fa": page(`<form method=post action=/2fa>${field("code", 40)}${submit(100)}</form>`),
  "/home": page(`<h1 id=welcome style="margin:40px">Welcome home</h1>`),
  "/opener": page(
    `<button id=b style="position:absolute;left:40px;top:40px;width:240px;height:60px" onclick="window.open('/popup','p','width=500,height=400')">Sign in with Provider</button><p id=out style="position:absolute;top:140px;left:40px">waiting</p><script>addEventListener('message',e=>{out.textContent='token:'+e.data.token})</script>`,
  ),
  "/popup": page(
    `<button id=a style="position:absolute;left:40px;top:40px;width:240px;height:60px" onclick="opener.postMessage({token:'T123'},'*');window.close()">Authorize</button>`,
  ),
  "/lab": page(
    `<div id=ctxbox style="position:absolute;left:40px;top:20px;width:300px;height:60px;background:#ddd">right click here</div>
<p id=ctx style="position:absolute;left:400px;top:20px">none</p>
${field("txt", 100)}
<textarea id=ta style="position:absolute;left:40px;top:160px;width:600px;height:200px;font-size:16px"></textarea>
<div style="position:absolute;top:0;left:0;width:10px;height:4000px"></div>
<script>ctxbox.addEventListener('contextmenu',e=>{e.preventDefault();ctx.textContent='contextmenu'})</script>`,
  ),
};

function startFixtureSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const redirect = (to: string, extra: Record<string, string> = {}) =>
      void res.writeHead(303, { Location: to, ...extra }).end();
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (url.pathname === "/login") {
          return redirect(form.get("user") === "alice" && form.get("pass") === "s3cret" ? "/2fa" : "/login?error=1");
        }
        if (url.pathname === "/2fa") {
          return form.get("code") === "123456"
            ? redirect("/home", { "Set-Cookie": "fixture_session=ok; Path=/; Max-Age=86400" })
            : redirect("/2fa?error=1");
        }
        res.writeHead(404).end();
      });
      return;
    }
    if (url.pathname === "/home" && !cookie.includes("fixture_session=ok")) return redirect("/login?next=%2Fhome");
    const html = PAGES[url.pathname];
    if (html === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

function ab(args: string[], env: BrowserEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      args,
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: 60_000 },
      (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) }),
    );
  });
}

async function evalJson<T>(env: BrowserEnv, js: string): Promise<T | undefined> {
  const out = (await ab(["eval", js], env)).stdout.trim();
  try {
    let value: unknown = JSON.parse(out);
    if (typeof value === "string") value = JSON.parse(value);
    return value as T;
  } catch {
    return undefined;
  }
}

async function until<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SseEvent = { event: string; data: unknown };

type Stream = {
  events: SseEvent[];
  cookie: string;
  ended: Promise<void>;
  abort(): void;
};

type Input = Record<string, unknown>;

const KEYS = { Tab: { key: "Tab", code: "Tab", vk: 9 }, Backspace: { key: "Backspace", code: "Backspace", vk: 8 } };

function keyEvents(ch: string, modifiers = 0, text = ch): Input[] {
  const upper = ch.toUpperCase();
  const code = /[a-z]/i.test(ch) ? `Key${upper}` : /\d/.test(ch) ? `Digit${ch}` : "Unidentified";
  const vk = /[a-z0-9]/i.test(ch) ? upper.charCodeAt(0) : 0;
  const base = { type: "input_keyboard", key: ch, code, windowsVirtualKeyCode: vk, modifiers };
  return [
    { ...base, eventType: "keyDown", text },
    { ...base, eventType: "keyUp" },
  ];
}

function namedKey(name: keyof typeof KEYS | "Enter"): Input[] {
  const spec = name === "Enter" ? { key: "Enter", code: "Enter", vk: 13 } : KEYS[name];
  const base = { type: "input_keyboard", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers: 0 };
  return [
    { ...base, eventType: "keyDown", ...(name === "Enter" ? { text: "\r" } : {}) },
    { ...base, eventType: "keyUp" },
  ];
}

const typeText = (text: string): Input[] => Array.from(text).flatMap((ch) => keyEvents(ch));

function click(x: number, y: number, button: "left" | "right" = "left"): Input[] {
  const base = { type: "input_mouse", x, y, button, clickCount: 1 };
  return [
    { ...base, eventType: "mouseMoved" },
    { ...base, eventType: "mousePressed" },
    { ...base, eventType: "mouseReleased" },
  ];
}

const okEnvelope = { status: "success", summary: "ok", artifacts: [], payload: {} };

describe.skipIf(!enabled)("live view end to end, real Chrome (STAGEFLOW_BROWSER_SMOKE=1)", () => {
  let root: string;
  let sockRoot: string;
  let saved: string | undefined;
  let site: { server: Server; origin: string };
  let cleanupProject: () => Promise<void>;
  let projectRoot: string;
  let host: Awaited<ReturnType<typeof startUiServer>> | undefined;
  let base: string;
  let store: ReturnType<typeof createRunStore>;
  let support: StageBrowserSupport;
  const runs: Array<{ runId: string; runDir: string }> = [];
  const streams: Stream[] = [];
  const agents: { loginAttempts: number } = { loginAttempts: 0 };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sf-lv-e2e-"));
    sockRoot = await mkdtemp(path.join("/tmp", "sfle-"));
    saved = process.env.STAGEFLOW_HOME;
    delete process.env.STAGEFLOW_BROWSER_SMOKE;
    process.env.STAGEFLOW_HOME = path.join(root, "home");
    resetGlobalStageflowHomeForTests();
    clearFindProjectRootCacheForTests();
    const project = await initTempGitRepo();
    projectRoot = project.root;
    cleanupProject = project.cleanup;
    site = await startFixtureSite();

    const inner = createLocalBrowserHost({ platform: "linux", hostEnv: {}, socketRoot: sockRoot, liveView: "relay" });
    const strip = <T extends { humanLogin?: boolean }>(request: T): Omit<T, "humanLogin"> => {
      const { humanLogin: _humanLogin, ...rest } = request;
      return rest;
    };
    const smokeHost: BrowserHost = {
      capabilities: { ...inner.capabilities, display: "virtual_display", liveView: "relay" },
      ensureProfileBrowser: (r) => inner.ensureProfileBrowser(strip(r)),
      stageEnv: (r) => inner.stageEnv(strip(r)),
      profileBrowserEnv: (r) => inner.profileBrowserEnv(strip(r)),
    };
    support = {
      host: smokeHost,
      profiles: createLocalProfileStore(),
      socketRoot: sockRoot,
      blockedSites: [],
      loginCheck: { settleMs: 50 },
    };

    const behaviors: Record<string, FakeAgentBehavior> = {
      login: {
        type: "wait_then_emit",
        waitRequests: [{ kind: "confirm", message: "Log in through the live view, then confirm.", id: "gate-1" }],
        envelope: okEnvelope,
      },
      work: { type: "emit", envelope: okEnvelope },
    };
    const agent: AgentPort = {
      openStage(input) {
        const id = input.stageId ?? input.stage.id;
        if (id === "login") agents.loginAttempts += 1;
        return new FakeAgent(behaviors[id] ?? { type: "never_emit" }).openStage(input);
      },
      async runStage(input) {
        return runStageViaOpen(agent, input);
      },
    };
    agents.loginAttempts = 0;
    store = createRunStore({ rootDir: path.join(root, "store") });
    host = await startUiServer({
      agent,
      cwd: projectRoot,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      browser: support,
    });
    base = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) s.abort();
    for (const run of runs.splice(0)) {
      await fetch(`${base}/api/runs/${run.runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ reason: "test cleanup" }),
      }).catch(() => undefined);
      await sleep(300);
      await teardownRunBrowsers(support, run).catch(() => undefined);
    }
    if (host !== undefined) {
      const closing = new Promise<void>((r) => host!.server.close(() => r()));
      host.server.closeAllConnections();
      await closing;
    }
    host = undefined;
    await new Promise((r) => site.server.close(r));
    await cleanupProject();
    if (saved === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = saved;
    resetGlobalStageflowHomeForTests();
    process.env.STAGEFLOW_BROWSER_SMOKE = "1";
    const leftovers = (() => {
      try {
        return execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
          .split("\n")
          .filter((line) => line.includes(sockRoot) || line.includes(root));
      } catch {
        return [];
      }
    })();
    await rm(sockRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    expect(leftovers).toEqual([]);
  });

  async function api<T = Record<string, unknown>>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: base },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  }

  async function startRun(loginPath: string): Promise<{ runId: string; runDir: string }> {
    await mkdir(path.join(projectRoot, "pipelines"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "stageflow.yaml"),
      [
        "version: 1",
        "catalog:",
        "  pipelines:",
        "    - pipelines",
        "  tasks:",
        "    - tasks",
        "  patterns:",
        '    pipeline: "*.yaml"',
        '    task: "*.yaml"',
        "",
      ].join("\n"),
    );
    const pipeline = path.join(projectRoot, "pipelines", "login.pipeline.yaml");
    const check = `${site.origin}/home`;
    await writeFile(
      pipeline,
      [
        "id: live-view-e2e",
        "stages:",
        "  - id: login",
        "    entry: true",
        "    system_prompt: Ask the operator to log in.",
        "    model: test/model",
        "    gate_kinds: [confirm]",
        "    browser:",
        "      profile: acct",
        `      login_url: ${site.origin}${loginPath}`,
        "      check:",
        `        url: ${check}`,
        `        logged_in_url: ${check}*`,
        `        logged_out_url: [${site.origin}/login*]`,
        "    verify:",
        "      - id: logged-in",
        "        type: browser_login",
        "    on_verify_fail:",
        "      mode: repair",
        "      max_attempts: 3",
        "      retry_safety: idempotent",
        "      include_failed_checks: true",
        "    route:",
        "      - to: work",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "  - id: work",
        "    system_prompt: Do the work.",
        "    model: test/model",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );
    const registered = await api("POST", "/api/projects", { project_root: projectRoot });
    if (registered.status >= 300) throw new Error(`register failed: ${JSON.stringify(registered.body)}`);
    const started = await api<{ runId?: string; error?: string }>("POST", "/api/runs", {
      project_root: projectRoot,
      task: { id: "t", goal: "log in" },
      pipeline: "pipelines/login.pipeline.yaml",
    });
    if (started.status >= 300 || started.body.runId === undefined) {
      throw new Error(`start failed: ${started.status} ${JSON.stringify(started.body)}`);
    }
    const run = { runId: started.body.runId, runDir: store.getWorkspaceDir(started.body.runId) };
    runs.push(run);
    return run;
  }

  type StageView = { stage_id: string; status: string; attempt_count?: number; pending_prompt?: Record<string, unknown> };

  async function runDetail(runId: string): Promise<{ status: string; stages: StageView[] }> {
    return (await api<{ status: string; stages: StageView[] }>("GET", `/api/runs/${runId}`)).body;
  }

  async function waitGate(runId: string, attempt: number): Promise<Record<string, unknown>> {
    return until(async () => {
      const stage = (await runDetail(runId)).stages?.find((s) => s.stage_id === "login");
      return stage?.status === "waiting_for_input" && stage.attempt_count === attempt ? stage.pending_prompt : undefined;
    }, `login gate attempt ${attempt}`, 120_000);
  }

  async function stageEnv(runId: string): Promise<BrowserEnv> {
    const runDirEnv = JSON.parse(
      await readFile(path.join(store.getWorkspaceDir(runId), "stages", "login", "browser-env.json"), "utf8"),
    ) as BrowserEnv;
    return runDirEnv;
  }

  async function openStream(handoffUrl: string, mode: "control" | "view" = "control"): Promise<Stream> {
    const ticket = await api<{ ticket: string }>("POST", `${handoffUrl}/ticket`, { mode });
    expect(ticket.status).toBe(200);
    const ctl = new AbortController();
    const res = await fetch(`${base}${handoffUrl}/events?ticket=${encodeURIComponent(ticket.body.ticket)}`, {
      headers: { Accept: "text/event-stream" },
      signal: ctl.signal,
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("sf_live_view="));
    expect(setCookie).toBeDefined();
    const cookie = setCookie!.split(";")[0]!;
    const events: SseEvent[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const ended = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (data !== "") events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      }
    })();
    const stream: Stream = { events, cookie, ended, abort: () => ctl.abort() };
    streams.push(stream);
    return stream;
  }

  function inputClient(handoffUrl: string, stream: Stream) {
    let nextAllowedAt = 0;
    const statuses: number[] = [];
    async function postOne(batch: Input[]): Promise<number> {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Date.now() + (batch.length * 1000) / 400;
      const res = await fetch(`${base}${handoffUrl}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-stageflow-live-view": "1",
          Origin: base,
          Cookie: stream.cookie,
        },
        body: JSON.stringify(batch),
      });
      statuses.push(res.status);
      return res.status;
    }
    return {
      statuses,
      async send(events: Input[]): Promise<number> {
        let last = 200;
        for (let i = 0; i < events.length; i += 64) last = await postOne(events.slice(i, i + 64));
        return last;
      },
    };
  }

  const frames = (s: Stream) => s.events.filter((e) => e.event === "frame");
  const retargets = (s: Stream) =>
    s.events.filter((e) => e.event === "retarget").map((e) => (e.data as { reason: string }).reason);

  async function center(env: BrowserEnv, selector: string): Promise<{ x: number; y: number }> {
    return until(async () => {
      const r = await evalJson<{ x: number; y: number } | null>(
        env,
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}); })()`,
      );
      return r ?? undefined;
    }, `element ${selector}`);
  }

  const pathname = async (env: BrowserEnv) =>
    (await ab(["eval", "location.pathname"], env)).stdout.replace(/"/g, "").trim();

  async function logIn(env: BrowserEnv, send: (e: Input[]) => Promise<number>): Promise<void> {
    await until(async () => (await pathname(env)) === "/login", "login page");
    const user = await center(env, "#user");
    expect(await send(click(user.x, user.y))).toBe(200);
    expect(await send(typeText("alice"))).toBe(200);
    expect(await send(namedKey("Tab"))).toBe(200);
    expect(await send(typeText("s3cret"))).toBe(200);
    expect(await send(namedKey("Enter"))).toBe(200);
    await until(async () => (await pathname(env)) === "/2fa", "2fa page");
    const code = await center(env, "#code");
    expect(await send(click(code.x, code.y))).toBe(200);
    expect(await send(typeText("123456"))).toBe(200);
    expect(await send(namedKey("Enter"))).toBe(200);
    await until(async () => (await pathname(env)) === "/home", "home page");
    expect((await ab(["eval", "document.getElementById('welcome').textContent"], env)).stdout).toContain("Welcome home");
  }

  async function confirm(runId: string, gate: Record<string, unknown>) {
    return api("POST", `/api/runs/${runId}/stages/login/answer`, {
      promptId: String(gate.id),
      kind: "confirm",
      decision: "accept",
    });
  }

  it("logs in through the live view API, Host check passes, revokes at gate close", async () => {
    const run = await startRun("/login");
    const gate = await waitGate(run.runId, 1);
    const handoff = gate.handoff as { kind: string; url: string };
    expect(handoff).toEqual({
      kind: "live_view",
      url: `/api/runs/${encodeURIComponent(run.runId)}/stages/login/live-view`,
    });
    expect(handoff.url).not.toMatch(/token|\?|=/i);

    const stream = await openStream(handoff.url);
    await until(() => frames(stream).length > 0 || undefined, "first frame");
    await until(
      () => stream.events.some((e) => e.event === "url" && String((e.data as { url: string }).url).endsWith("/login")) || undefined,
      "initial address",
    );

    const env = await stageEnv(run.runId);
    const input = inputClient(handoff.url, stream);
    await logIn(env, input.send);
    expect(input.statuses.every((s) => s === 200)).toBe(true);

    expect((await confirm(run.runId, gate)).status).toBe(202);
    await until(async () => (await runDetail(run.runId)).status === "succeeded", "run success", 120_000);
    await until(() => stream.events.some((e) => e.event === "closed") || undefined, "closed event");
    expect(stream.events.at(-1)).toMatchObject({ event: "closed" });
    await stream.ended;
    const after = await fetch(`${base}${handoff.url}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stageflow-live-view": "1", Origin: base, Cookie: stream.cookie },
      body: JSON.stringify(click(10, 10)),
    });
    expect([401, 409]).toContain(after.status);
    expect(agents.loginAttempts).toBe(1);
  }, 300_000);

  it("wrong confirm while logged out produces a new gate and the live view still works", async () => {
    const run = await startRun("/login");
    const gate1 = await waitGate(run.runId, 1);
    const handoff = (gate1.handoff as { url: string }).url;
    const first = await openStream(handoff);
    await until(() => frames(first).length > 0 || undefined, "first frame");

    expect((await confirm(run.runId, gate1)).status).toBe(202);
    const gate2 = await waitGate(run.runId, 2);
    expect(gate2.handoff).toEqual(gate1.handoff);
    await first.ended;
    expect(first.events.at(-1)).toMatchObject({ event: "closed" });

    const second = await openStream(handoff);
    await until(() => frames(second).length > 0 || undefined, "frame on new stream");
    const env = await stageEnv(run.runId);
    const input = inputClient(handoff, second);
    await logIn(env, input.send);

    expect((await confirm(run.runId, gate2)).status).toBe(202);
    await until(async () => (await runDetail(run.runId)).status === "succeeded", "run success", 120_000);
  }, 300_000);

  it("popup opened by the page is followed and the opener receives the token", async () => {
    const run = await startRun("/opener");
    const gate = await waitGate(run.runId, 1);
    const handoff = (gate.handoff as { url: string }).url;
    const stream = await openStream(handoff);
    await until(() => frames(stream).length > 0 || undefined, "first frame");
    const env = await stageEnv(run.runId);
    const input = inputClient(handoff, stream);

    const opener = await center(env, "#b");
    expect(await input.send(click(opener.x, opener.y))).toBe(200);
    await until(() => retargets(stream).length >= 1 || undefined, "popup retarget");
    expect(retargets(stream)[0]).toBe("popup_opened");

    const popup = await until(async () => {
      const tabs = JSON.parse((await ab(["tab", "list", "--json"], env)).stdout) as {
        data?: { tabs?: { url?: string }[] };
      };
      return tabs.data?.tabs?.some((t) => t.url?.endsWith("/popup")) || undefined;
    }, "popup tab");
    expect(popup).toBe(true);
    const popupButton = { x: 160, y: 70 };
    expect(await input.send(click(popupButton.x, popupButton.y))).toBe(200);
    await until(() => retargets(stream).length >= 2 || undefined, "retarget back");
    expect(retargets(stream)[1]).toBe("tab_closed");

    const out = await until(async () => {
      const text = (await ab(["eval", "document.getElementById('out').textContent"], env)).stdout;
      return text.includes("token:T123") ? text : undefined;
    }, "token in opener");
    expect(out).toContain("token:T123");
  }, 300_000);

  it("verifies wheel, right click, modifier mask, char events, backspace and paste-sized input", async () => {
    const run = await startRun("/lab");
    const gate = await waitGate(run.runId, 1);
    const handoff = (gate.handoff as { url: string }).url;
    const stream = await openStream(handoff);
    await until(() => frames(stream).length > 0 || undefined, "first frame");
    const env = await stageEnv(run.runId);
    const input = inputClient(handoff, stream);

    const scrollY = async () => Number((await ab(["eval", "window.scrollY"], env)).stdout.trim());
    expect(await scrollY()).toBe(0);
    expect(
      await input.send([{ type: "input_mouse", eventType: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: 600 }]),
    ).toBe(200);
    await until(async () => ((await scrollY()) > 0 ? true : undefined), "wheel scroll");
    await input.send([{ type: "input_mouse", eventType: "mouseWheel", x: 500, y: 400, deltaX: 0, deltaY: -2000 }]);
    await until(async () => (await scrollY()) === 0, "scroll back to top");

    const box = await center(env, "#ctxbox");
    expect(await input.send(click(box.x, box.y, "right"))).toBe(200);
    await until(async () => {
      const text = (await ab(["eval", "document.getElementById('ctx').textContent"], env)).stdout;
      return text.includes("contextmenu") ? text : undefined;
    }, "contextmenu");

    const txt = await center(env, "#txt");
    const value = async (id: string) =>
      JSON.parse((await ab(["eval", `document.getElementById('${id}').value`], env)).stdout.trim()) as string;
    expect(await input.send(click(txt.x, txt.y))).toBe(200);
    expect(await input.send(keyEvents("a", 8, "A"))).toBe(200);
    expect(await until(async () => ((await value("txt")) === "A" ? "A" : undefined), "shift A")).toBe("A");
    expect(await input.send(keyEvents("a"))).toBe(200);
    expect(await until(async () => ((await value("txt")) === "Aa" ? "Aa" : undefined), "plain a")).toBe("Aa");
    expect(await input.send(namedKey("Backspace"))).toBe(200);
    expect(await until(async () => ((await value("txt")) === "A" ? "A" : undefined), "backspace")).toBe("A");
    expect(
      await input.send(Array.from("xyz").map((ch) => ({ type: "input_keyboard", eventType: "char", text: ch }))),
    ).toBe(200);
    expect(await until(async () => ((await value("txt")) === "Axyz" ? "Axyz" : undefined), "char events")).toBe("Axyz");

    const ta = await center(env, "#ta");
    expect(await input.send(click(ta.x, ta.y))).toBe(200);
    const paste = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const before = input.statuses.length;
    const started = Date.now();
    await input.send(Array.from(paste).map((ch) => ({ type: "input_keyboard", eventType: "char", text: ch })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(input.statuses.slice(before).every((s) => s === 200)).toBe(true);
    expect(await until(async () => ((await value("ta")) === paste ? paste : undefined), "paste arrives")).toBe(paste);
  }, 300_000);
});
