import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserHost, BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createLoginRoutedHost } from "../src/browser/loginRoutedHost.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { createProfileHostHints } from "../src/browser/profileHostHint.js";
import { createProfileCatalog } from "../src/browser/profileCatalog.js";
import { createProfileLoginFlow, LoginFlowError } from "../src/browser/profileLoginFlow.js";
import { createProfileMetaStore, type ProfileRecipe } from "../src/browser/profileMeta.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-flow-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

const RECIPE: ProfileRecipe = {
  check: { url: "https://site.test/home", logged_in_url: "https://site.test/home*", logged_out_url: ["https://site.test/login*"] },
  login_url: "https://site.test/login",
};
const IN = "https://site.test/home";
const OUT = "https://site.test/login?next=%2Fhome";

function fakeHost(name: string, capabilities: BrowserHost["capabilities"]): BrowserHost {
  return {
    capabilities,
    async ensureProfileBrowser() {
      return { cdpAddress: `ws://${name}`, anchorEnv: { AGENT_BROWSER_SESSION: name }, restarted: false };
    },
    async stageEnv() {
      return { AGENT_BROWSER_SESSION: `${name}-stage`, AGENT_BROWSER_CDP: `ws://${name}` };
    },
    async profileBrowserEnv() {
      return { AGENT_BROWSER_SESSION: `${name}-profile` };
    },
  };
}

type Urls = { login: string; work: string };

async function setup(options: { urls?: Partial<Urls>; routed?: boolean; loginCapabilities?: BrowserHost["capabilities"]; copyOk?: boolean } = {}) {
  const urls: Urls = { login: OUT, work: OUT, ...options.urls };
  const calls: Array<{ args: string[]; session: string }> = [];
  const runner: BrowserRunner = async (args, env) => {
    const session = env.AGENT_BROWSER_SESSION ?? "";
    calls.push({ args, session });
    if (args[0] === "get" && args[1] === "url") return { code: 0, stdout: `${session.startsWith("login") ? urls.login : urls.work}\n` };
    if (args[0] === "state") return { code: options.copyOk === false ? 1 : 0 };
    return { code: 0, stdout: "" };
  };
  const hints = createProfileHostHints();
  const meta = createProfileMetaStore();
  const profiles = createLocalProfileStore();
  const locks = createInMemoryProfileLock();
  const work = fakeHost("work", { display: "virtual_display", liveView: "relay" });
  const login = fakeHost("login", options.loginCapabilities ?? { display: "local_window", ownBrowser: true });
  const host = options.routed === false ? work : createLoginRoutedHost({ work, login, hints, tempDir: path.join(home, "tmp"), loginCheck: { waitMs: 1, settleMs: 0 } });
  const support: StageBrowserSupport = { host, profiles, runner, locks, blockedSites: [], closeWaitMs: 20, loginCheck: { waitMs: 1, settleMs: 0 } };
  const flow = createProfileLoginFlow({ support, scope: "local", tmpRoot: path.join(home, "flows"), ttlMs: 60_000 });
  const catalog = createProfileCatalog({
    scope: "local",
    profiles,
    locks,
    isRunLive: async () => true,
    hints,
    meta,
    auditLastUsed: async () => ({}),
    pinnedByConfig: new Set(),
    closeProfileSession: async () => undefined,
    flow,
  });
  const handle = await profiles.open({ scope: "local", name: "acct" });
  await meta.record(handle, { sites: ["site.test"], ...RECIPE });
  const leftovers = async () => (await readdir(path.join(home, "flows")).catch(() => [])).length;
  return { flow, catalog, hints, meta, handle, calls, urls, locks, leftovers };
}

describe("Check now", () => {
  it("runs the profile's own login check and cleans up after itself", async () => {
    const t = await setup({ urls: { work: IN } });
    const result = await t.catalog.checkNow("acct");
    expect(result).toMatchObject({ state: "logged_in", site: "site.test", profile: { name: "acct", can_check: true, logging_in: false } });
    expect((await t.meta.get(t.handle))?.last_verified_at).toBeTypeOf("string");
    expect(await t.leftovers()).toBe(0);
    const again = await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "r", stageId: "s" });
    expect(again.status).not.toBe("queued");
  });

  it("reports logged out and unknown honestly", async () => {
    const out = await setup();
    expect((await out.catalog.checkNow("acct")).state).toBe("logged_out");
    expect((await out.meta.get(out.handle))?.last_verified_at).toBeUndefined();
    const odd = await setup({ urls: { work: "https://elsewhere.test/x" } });
    expect((await odd.catalog.checkNow("acct")).state).toBe("unknown");
  });

  it("needs a recorded check, and refuses a profile a run holds", async () => {
    const t = await setup();
    await t.meta.clear(t.handle);
    await expect(t.catalog.checkNow("acct")).rejects.toMatchObject({ code: "no_recipe", status: 409 });
    await t.meta.record(t.handle, { sites: [], ...RECIPE });
    await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "run-9", stageId: "s" });
    await expect(t.catalog.checkNow("acct")).rejects.toMatchObject({ code: "profile_busy" });
  });
});

describe("Log in again", () => {
  it("opens the login page in the operator's Chrome and holds the profile until finished", async () => {
    const t = await setup({ urls: { login: OUT } });
    const started = await t.catalog.startLogin("acct");
    expect(started).toMatchObject({ where: "own_chrome", site: "site.test", profile: { logging_in: true } });
    expect(t.calls.some((c) => c.args[0] === "open" && c.args[1] === "https://site.test/login" && c.session === "login-stage")).toBe(true);
    const other = await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "run-2", stageId: "s" });
    expect(other.status).toBe("queued");
    await expect(t.catalog.startLogin("acct")).rejects.toMatchObject({ code: "login_in_progress" });
    await expect(t.catalog.checkNow("acct")).rejects.toMatchObject({ code: "login_in_progress" });
    await t.catalog.cancelLogin("acct");
  });

  it("stays waiting while the page is still logged out, then copies the login to the Host's browser", async () => {
    const t = await setup({ urls: { login: OUT, work: IN } });
    await t.catalog.startLogin("acct");
    const pending = await t.catalog.finishLogin("acct");
    expect(pending).toMatchObject({ ok: false, state: "logged_out", profile: { logging_in: true } });
    t.urls.login = IN;
    const done = await t.catalog.finishLogin("acct");
    expect(done).toMatchObject({ ok: true, where: "host_browser", state: "logged_in", profile: { logging_in: false } });
    const names = t.calls.map((c) => `${c.args[0]}${c.args[1] === "save" || c.args[1] === "load" ? ` ${c.args[1]}` : ""}@${c.session}`);
    expect(names).toContain("state save@login");
    expect(names).toContain("state load@work");
    const saved = await t.meta.get(t.handle);
    expect(saved).toMatchObject({ login_where: "host_browser", sites: ["site.test"] });
    expect(saved?.last_login_at).toBeTypeOf("string");
    expect(await t.leftovers()).toBe(0);
    const free = await t.locks.acquire({ scope: "local", name: "acct" }, { runId: "r", stageId: "s" });
    expect(free.status).not.toBe("queued");
  });

  it("keeps the login in the operator's Chrome and pins the profile when the site rejects the copy", async () => {
    const t = await setup({ urls: { login: IN, work: OUT } });
    await t.catalog.startLogin("acct");
    const done = await t.catalog.finishLogin("acct");
    expect(done).toMatchObject({ ok: true, where: "own_chrome", profile: { pinned: { by: "learned" } } });
    expect((await t.hints.get(t.handle))?.mode).toBe("attach");
  });

  it("can be cancelled, which closes the tab and frees the profile", async () => {
    const t = await setup();
    await t.catalog.startLogin("acct");
    const after = await t.catalog.cancelLogin("acct");
    expect(after.logging_in).toBe(false);
    expect(t.calls.some((c) => c.args[0] === "tab" && c.args[1] === "close")).toBe(true);
    expect(await t.leftovers()).toBe(0);
    await expect(t.catalog.finishLogin("acct")).rejects.toMatchObject({ code: "no_login", status: 404 });
  });

  it("explains when this Host has no window to log in with", async () => {
    const noWindow = await setup({ routed: false });
    await expect(noWindow.catalog.startLogin("acct")).rejects.toMatchObject({ code: "login_unsupported", status: 409 });
    expect(noWindow.locks).toBeDefined();
    const free = await noWindow.locks.acquire({ scope: "local", name: "acct" }, { runId: "r", stageId: "s" });
    expect(free.status).not.toBe("queued");
  });

  it("needs a recorded check", async () => {
    const t = await setup();
    await t.meta.clear(t.handle);
    await expect(t.catalog.startLogin("acct")).rejects.toBeInstanceOf(LoginFlowError);
  });
});
