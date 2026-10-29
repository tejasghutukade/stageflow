import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserEnv, BrowserHost, BrowserRunner, ProfileBrowserRequest } from "../src/browser/browserHost.js";
import { createLoginRoutedHost } from "../src/browser/loginRoutedHost.js";
import { createProfileHostHints } from "../src/browser/profileHostHint.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-routed-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

function fakeHost(name: string, capabilities: BrowserHost["capabilities"]) {
  const ensured: Array<{ previous?: string; humanLogin?: boolean }> = [];
  const host: BrowserHost = {
    capabilities,
    async ensureProfileBrowser(request) {
      ensured.push({
        ...(request.previous !== undefined ? { previous: request.previous.cdpAddress } : {}),
        ...(request.humanLogin === true ? { humanLogin: true } : {}),
      });
      return { cdpAddress: `ws://${name}`, anchorEnv: { AGENT_BROWSER_SESSION: name }, restarted: false };
    },
    async stageEnv() {
      return { AGENT_BROWSER_SESSION: `${name}-stage` };
    },
    async profileBrowserEnv() {
      return { AGENT_BROWSER_SESSION: `${name}-profile` };
    },
  };
  return { host, ensured };
}

const CHECK = {
  url: "https://site.test/home",
  logged_in_url: "https://site.test/home*",
  logged_out_url: ["https://site.test/login*"],
};

type Call = { args: string[]; session: string | undefined };

function makeRunner(opts: { probeUrl?: string; saveCode?: number; loadCode?: number } = {}) {
  const calls: Call[] = [];
  const files: string[] = [];
  const runner: BrowserRunner = async (args, env: BrowserEnv) => {
    calls.push({ args, session: env.AGENT_BROWSER_SESSION });
    if (args[0] === "state" && args[1] === "save") {
      files.push(args[2]!);
      return { code: opts.saveCode ?? 0 };
    }
    if (args[0] === "state" && args[1] === "load") return { code: opts.loadCode ?? 0 };
    if (args[0] === "get" && args[1] === "url") return { code: 0, stdout: `${opts.probeUrl ?? "https://site.test/home"}\n` };
    return { code: 0 };
  };
  return { runner, calls, files };
}

async function setup(options: { profiles?: "local" | "volume"; probeUrl?: string; saveCode?: number; loadCode?: number; pinned?: string[] } = {}) {
  const work = fakeHost("work", { display: "headless_only", liveView: "relay" });
  const login = fakeHost("login", { display: "local_window", ownBrowser: true });
  const hints = createProfileHostHints();
  const sessionRunner = makeRunner(options);
  const host = createLoginRoutedHost({
    work: work.host,
    login: login.host,
    hints,
    ...(options.pinned !== undefined ? { pinnedProfiles: new Set(options.pinned) } : {}),
    tempDir: path.join(home, "tmp"),
    loginCheck: { waitMs: 1, settleMs: 0 },
  });
  const profiles = options.profiles === "volume" ? createVolumeProfileStore() : createLocalProfileStore();
  const profile = await profiles.open({ scope: "local", name: "acct" });
  const request = (extra: Partial<ProfileBrowserRequest> = {}): ProfileBrowserRequest => ({
    runId: "run-1",
    browser: { profile: "acct" },
    profile,
    runner: sessionRunner.runner,
    ...extra,
  });
  return { host, work, login, hints, profile, request, ...sessionRunner };
}

describe("login routed host", () => {
  it("sends human login to the operator's browser and other stages to the headless one", async () => {
    const t = await setup();
    const a = await t.host.ensureProfileBrowser(t.request({ humanLogin: true }));
    expect(a).toMatchObject({ cdpAddress: "ws://login", via: "login" });
    const b = await t.host.ensureProfileBrowser(t.request());
    expect(b.via).toBe("work");
    expect(t.login.ensured).toHaveLength(1);
    expect(t.work.ensured).toHaveLength(1);
  });

  it("describes the operator's own window for login stages only", async () => {
    const t = await setup();
    expect(t.host.capabilitiesFor?.({ humanLogin: true })).toMatchObject({ display: "local_window", ownBrowser: true });
    expect(t.host.capabilitiesFor?.({})).toMatchObject({ display: "headless_only" });
    expect(await t.host.stageEnv({ runId: "r", stageId: "s", browser: {}, humanLogin: true })).toEqual({ AGENT_BROWSER_SESSION: "login-stage" });
    expect(await t.host.stageEnv({ runId: "r", stageId: "s", browser: {} })).toEqual({ AGENT_BROWSER_SESSION: "work-stage" });
  });

  it("copies the session into the headless browser after login, checks it there, and detaches from the operator's browser", async () => {
    const t = await setup();
    const login = await t.host.ensureProfileBrowser(t.request({ humanLogin: true, browser: { profile: "acct", check: CHECK } }));
    const next = await t.host.ensureProfileBrowser(t.request({ previous: { cdpAddress: login.cdpAddress, anchorEnv: login.anchorEnv, via: "login" } }));
    expect(next).toMatchObject({ cdpAddress: "ws://work", via: "work", restarted: true });
    const names = t.calls.map((c) => `${c.args.join(" ").replace(/\/.*\/state\.json/, "<file>")}@${c.session}`);
    expect(names).toContain("state save <file>@login");
    expect(names).toContain("state load <file>@work");
    expect(t.calls.findIndex((c) => c.args[0] === "state" && c.args[1] === "load")).toBeLessThan(t.calls.findIndex((c) => c.args[0] === "open"));
    expect(names).toContain("close@login");
    expect(await t.hints.get(t.profile)).toBeUndefined();
  });

  it("deletes the session file whatever happens", async () => {
    const t = await setup();
    const login = await t.host.ensureProfileBrowser(t.request({ humanLogin: true, browser: { profile: "acct", check: CHECK } }));
    await t.host.ensureProfileBrowser(t.request({ previous: { cdpAddress: login.cdpAddress, anchorEnv: login.anchorEnv, via: "login" } }));
    expect(await readdir(path.join(home, "tmp"))).toEqual([]);
    const failing = await setup({ saveCode: 1 });
    const l2 = await failing.host.ensureProfileBrowser(failing.request({ humanLogin: true }));
    await failing.host.ensureProfileBrowser(failing.request({ previous: { cdpAddress: l2.cdpAddress, anchorEnv: l2.anchorEnv, via: "login" } }));
    expect(await readdir(path.join(home, "tmp"))).toEqual([]);
  });

  it("stays on the operator's browser and remembers it when the site rejects the copied session", async () => {
    const t = await setup({ probeUrl: "https://site.test/login?next=%2Fhome" });
    const login = await t.host.ensureProfileBrowser(t.request({ humanLogin: true, browser: { profile: "acct", check: CHECK } }));
    const next = await t.host.ensureProfileBrowser(t.request({ previous: { cdpAddress: login.cdpAddress, anchorEnv: login.anchorEnv, via: "login" } }));
    expect(next).toMatchObject({ cdpAddress: "ws://login", via: "login", restarted: false });
    expect((await t.hints.get(t.profile))?.mode).toBe("attach");
    expect(t.calls.some((c) => c.args[0] === "close" && c.session === "work")).toBe(true);
    expect(t.calls.some((c) => c.args[0] === "close" && c.session === "login")).toBe(false);
  });

  it("does not learn from a failed copy, but still keeps the run on the operator's browser", async () => {
    const t = await setup({ loadCode: 1 });
    const login = await t.host.ensureProfileBrowser(t.request({ humanLogin: true, browser: { profile: "acct", check: CHECK } }));
    const next = await t.host.ensureProfileBrowser(t.request({ previous: { cdpAddress: login.cdpAddress, anchorEnv: login.anchorEnv, via: "login" } }));
    expect(next.via).toBe("login");
    expect(await t.hints.get(t.profile)).toBeUndefined();
  });

  it("trusts the copy when no login check is known", async () => {
    const t = await setup();
    const login = await t.host.ensureProfileBrowser(t.request({ humanLogin: true }));
    const next = await t.host.ensureProfileBrowser(t.request({ previous: { cdpAddress: login.cdpAddress, anchorEnv: login.anchorEnv, via: "login" } }));
    expect(next.via).toBe("work");
    expect(t.calls.some((c) => c.args[0] === "open")).toBe(false);
  });

  it("uses the operator's browser for every stage of a remembered or pinned profile, closing a headless anchor in the way", async () => {
    const remembered = await setup();
    await remembered.hints.set(remembered.profile, { mode: "attach", reason: "test" });
    const first = await remembered.host.ensureProfileBrowser(remembered.request({ previous: { cdpAddress: "ws://work", anchorEnv: { AGENT_BROWSER_SESSION: "work" }, via: "work" } }));
    expect(first).toMatchObject({ cdpAddress: "ws://login", via: "login", restarted: true });
    expect(remembered.calls.some((c) => c.args[0] === "close" && c.session === "work")).toBe(true);
    expect(remembered.work.ensured).toHaveLength(0);
    const again = await remembered.host.ensureProfileBrowser(remembered.request({ previous: { cdpAddress: first.cdpAddress, anchorEnv: first.anchorEnv, via: "login" } }));
    expect(again.via).toBe("login");
    expect(remembered.login.ensured.at(-1)?.previous).toBe("ws://login");

    const pinned = await setup({ pinned: ["acct"] });
    expect((await pinned.host.ensureProfileBrowser(pinned.request())).via).toBe("login");
  });

  it("closes the headless anchor before a login stage takes over, and keeps hints in memory for a volume profile", async () => {
    const t = await setup({ profiles: "volume" });
    const result = await t.host.ensureProfileBrowser(t.request({ humanLogin: true, previous: { cdpAddress: "ws://work", anchorEnv: { AGENT_BROWSER_SESSION: "work" }, via: "work" } }));
    expect(result).toMatchObject({ via: "login", restarted: true });
    expect(t.calls.some((c) => c.args[0] === "close" && c.session === "work")).toBe(true);
    await t.hints.set(t.profile, { mode: "attach", reason: "x" });
    expect((await t.hints.get(t.profile))?.mode).toBe("attach");
    await t.hints.clear(t.profile);
    expect(await t.hints.get(t.profile)).toBeUndefined();
  });

  it("keeps hints in the profile's state folder across processes", async () => {
    const t = await setup();
    await t.hints.set(t.profile, { mode: "attach", reason: "why" });
    const other = createProfileHostHints();
    expect(await other.get(t.profile)).toMatchObject({ mode: "attach", reason: "why" });
    await t.hints.clear(t.profile);
    expect(await other.get(t.profile)).toBeUndefined();
  });
});
