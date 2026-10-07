import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserHost,
  type BrowserRunner,
  type BrowserStageRequest,
} from "../src/browser/browserHost.js";
import { resolveBrowserHostCapabilities } from "../src/browser/hostCapabilities.js";
import { createFakeRemoteBrowserHost } from "../src/browser/fakeRemoteBrowserHost.js";
import { createContainerBrowserHost } from "../src/browser/containerBrowserHost.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { createFakeContainerBrowsers } from "./helpers/fakeContainerBrowsers.js";
import { createFakeProviderSession } from "./helpers/fakeProviderSession.js";
import { createSessionApiSandboxOrchestrator } from "../src/browser/sessionApiSandboxOrchestrator.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { createInMemoryProfileStore } from "../src/browser/memoryProfileStore.js";
import {
  LOCAL_BROWSER_SCOPE,
  type ProfileHandle,
  type ProfileStore,
} from "../src/browser/profileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let home: string;
let sockRoot: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-browser-host-"));
  sockRoot = await mkdtemp(path.join("/tmp", "sfbt-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(sockRoot, { recursive: true, force: true });
});

const implementations: Array<{
  name: string;
  make: () => { host: BrowserHost; profiles: ProfileStore };
  remote: boolean;
  /** Where a remote host sends stages, when it is fixed ahead of time. */
  remoteAddress?: string;
}> = [
  {
    name: "local",
    make: () => ({
      host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: sockRoot }),
      profiles: createLocalProfileStore(),
    }),
    remote: false,
  },
  {
    name: "fake remote",
    make: () => ({
      host: createFakeRemoteBrowserHost("wss://browsers.example/session-1"),
      profiles: createInMemoryProfileStore(),
    }),
    remote: true,
    remoteAddress: "wss://browsers.example/session-1",
  },
  {
    name: "container (fake orchestrator)",
    make: () => {
      const fake = createFakeContainerBrowsers();
      return {
        host: createContainerBrowserHost({
          orchestrator: fake.orchestrator,
          endpoint: fake.endpoint,
          local: { platform: "darwin", hostEnv: {}, socketRoot: sockRoot },
          pollMs: 1,
        }),
        profiles: createVolumeProfileStore(),
      };
    },
    remote: true,
    remoteAddress: "ws://10.0.0.1:9222/devtools/browser/b1",
  },
  {
    name: "container host over a provider-style session API adapter",
    make: () => {
      const provider = createFakeProviderSession();
      return {
        host: createContainerBrowserHost({
          orchestrator: createSessionApiSandboxOrchestrator({ client: provider.api }),
          endpoint: provider.endpoint,
          local: { platform: "darwin", hostEnv: {}, socketRoot: sockRoot },
          pollMs: 1,
        }),
        profiles: createVolumeProfileStore(),
      };
    },
    remote: true,
    remoteAddress: "ws://10.1.0.1:9222/devtools/browser/p1",
  },
];

async function request(
  profiles: ProfileStore,
  overrides: Partial<BrowserStageRequest> & { profileName?: string } = {},
): Promise<BrowserStageRequest> {
  const { profileName, ...rest } = overrides;
  const profile: ProfileHandle | undefined =
    profileName !== undefined
      ? await profiles.open({ scope: LOCAL_BROWSER_SCOPE, name: profileName })
      : undefined;
  return {
    runId: "run-1",
    stageId: "stage-a",
    browser: profileName !== undefined ? { profile: profileName } : {},
    ...(profile !== undefined ? { profile } : {}),
    ...rest,
  };
}

const CDP = "ws://127.0.0.1:9222/devtools/browser/abc";

function anchorRunner(calls: string[][] = []): BrowserRunner {
  return async (args) => {
    calls.push(args);
    return { code: 0, stdout: args[0] === "get" ? `${CDP}\n` : "" };
  };
}

/** Per-stage env the way the pipeline gets it: shared browser first, then the stage attach. */
async function stageEnvOf(host: BrowserHost, req: BrowserStageRequest) {
  if (req.profile === undefined) return host.stageEnv(req);
  const shared = await host.ensureProfileBrowser({
    runId: req.runId,
    browser: req.browser,
    profile: req.profile,
    runner: anchorRunner(),
  });
  return host.stageEnv({ ...req, cdpAddress: shared.cdpAddress });
}

describe.each(implementations)("BrowserHost contract: $name", ({ make, remote, remoteAddress }) => {
  it("reports a complete capability record that never claims an unwired relay", () => {
    const { host } = make();
    const caps = resolveBrowserHostCapabilities(host.capabilities);
    expect(["local_window", "virtual_display", "headless_only"]).toContain(caps.display);
    expect(caps.liveView).toBe("none");
    expect(["cdp", "host_launched"]).toContain(caps.attach);
  });

  it("returns identical env for identical requests", async () => {
    const { host, profiles } = make();
    const req = await request(profiles, { profileName: "acct" });
    expect(await stageEnvOf(host, req)).toEqual(await stageEnvOf(host, req));
  });

  it("returns only string values and disables the idle timeout", async () => {
    const { host, profiles } = make();
    const env = await stageEnvOf(host, await request(profiles, { profileName: "acct" }));
    for (const value of Object.values(env)) expect(typeof value).toBe("string");
    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("0");
    expect(env.AGENT_BROWSER_SESSION).toBeTruthy();
  });

  it("gives every stage its own session and the same shared browser address", async () => {
    const { host, profiles } = make();
    const a = await stageEnvOf(host, await request(profiles, { profileName: "acct", stageId: "one" }));
    const b = await stageEnvOf(host, await request(profiles, { profileName: "acct", stageId: "two" }));
    const otherRun = await stageEnvOf(
      host,
      await request(profiles, { profileName: "acct", stageId: "one", runId: "run-2" }),
    );
    expect(a.AGENT_BROWSER_SESSION).not.toBe(b.AGENT_BROWSER_SESSION);
    expect(a.AGENT_BROWSER_SESSION).not.toBe(otherRun.AGENT_BROWSER_SESSION);
    expect(a.AGENT_BROWSER_CDP).toBe(b.AGENT_BROWSER_CDP);
    expect(a.AGENT_BROWSER_PIN_TAB).toBe("1");
    expect(a).not.toHaveProperty("AGENT_BROWSER_PROFILE");
  });

  it("returns the shared browser address and an owning env that is not a stage env", async () => {
    const { host, profiles } = make();
    const req = await request(profiles, { profileName: "acct" });
    const shared = await host.ensureProfileBrowser({
      runId: req.runId,
      browser: req.browser,
      profile: req.profile!,
      runner: anchorRunner(),
    });
    expect(shared.cdpAddress).toMatch(/^wss?:\/\//);
    expect(shared.restarted).toBe(false);
    expect(shared.anchorEnv.AGENT_BROWSER_SESSION).toBeTruthy();
    const stage = await host.stageEnv({ ...req, cdpAddress: shared.cdpAddress });
    expect(stage.AGENT_BROWSER_SESSION).not.toBe(shared.anchorEnv.AGENT_BROWSER_SESSION);
  });

  it("gives profile-less stages distinct sessions per run and stage", async () => {
    const { host, profiles } = make();
    const base = await stageEnvOf(host, await request(profiles));
    const otherStage = await stageEnvOf(host, await request(profiles, { stageId: "stage-b" }));
    const otherRun = await stageEnvOf(host, await request(profiles, { runId: "run-2" }));
    const sessions = new Set([
      base.AGENT_BROWSER_SESSION,
      otherStage.AGENT_BROWSER_SESSION,
      otherRun.AGENT_BROWSER_SESSION,
    ]);
    expect(sessions.size).toBe(3);
  });

  it("does not read settings from the Host ambient environment", async () => {
    const { host, profiles } = make();
    process.env.AGENT_BROWSER_PROFILE = "/ambient/profile";
    process.env.AGENT_BROWSER_SESSION = "ambient";
    process.env.AGENT_BROWSER_CDP = "ws://ambient";
    try {
      const env = await stageEnvOf(host, await request(profiles, { profileName: "acct" }));
      expect(env.AGENT_BROWSER_SESSION).not.toBe("ambient");
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(env.AGENT_BROWSER_CDP).not.toBe("ws://ambient");
    } finally {
      delete process.env.AGENT_BROWSER_PROFILE;
      delete process.env.AGENT_BROWSER_SESSION;
      delete process.env.AGENT_BROWSER_CDP;
    }
  });

  if (remote) {
    it("gives the stage the remote address and no local profile path", async () => {
      const { host, profiles } = make();
      const req = await request(profiles, { profileName: "acct" });
      const env = await stageEnvOf(host, req);
      expect(env.AGENT_BROWSER_CDP).toBe(remoteAddress);
      expect(env.AGENT_BROWSER_PIN_TAB).toBe("1");
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(JSON.stringify(env)).not.toContain(req.profile!.profileDir ?? "\0");
    });
  } else {
    it("attaches the stage to the local anchor address and keeps the profile dir off the stage", async () => {
      const { host, profiles } = make();
      const req = await request(profiles, { profileName: "acct" });
      const env = await stageEnvOf(host, req);
      expect(env.AGENT_BROWSER_CDP).toBe(CDP);
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(JSON.stringify(env)).not.toContain(req.profile!.profileDir!);
      const owning = await host.profileBrowserEnv({
        runId: req.runId,
        browser: req.browser,
        profile: req.profile!,
      });
      expect(owning.AGENT_BROWSER_PROFILE).toBe(req.profile!.profileDir);
      expect(owning).not.toHaveProperty("AGENT_BROWSER_CDP");
    });

    it("starts the anchor once with open then get cdp-url; a later call only probes the address", async () => {
      const { host, profiles } = make();
      const req = await request(profiles, { profileName: "acct" });
      const calls: string[][] = [];
      const base = { runId: req.runId, browser: req.browser, profile: req.profile!, runner: anchorRunner(calls) };
      const first = await host.ensureProfileBrowser(base);
      expect(calls.map((c) => c.join(" "))).toEqual(["open about:blank", "get cdp-url"]);
      calls.length = 0;
      const again = await host.ensureProfileBrowser({ ...base, previous: first });
      expect(calls.map((c) => c.join(" "))).toEqual(["get cdp-url"]);
      expect(again.restarted).toBe(false);
      const moved = await host.ensureProfileBrowser({
        ...base,
        previous: { ...first, cdpAddress: "ws://127.0.0.1:1/devtools/browser/old" },
      });
      expect(moved.restarted).toBe(true);
      expect(moved.cdpAddress).toBe(CDP);
    });
  }
});

describe("local BrowserHost settings", () => {
  const local = (opts: Parameters<typeof createLocalBrowserHost>[0] = {}) => ({
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: sockRoot, ...opts }),
    profiles: createLocalProfileStore(),
  });

  it("profile stage: anchor owns the profile, stage attaches; allowlist omitted on both", async () => {
    const { host, profiles } = local();
    const req = await request(profiles, { profileName: "acct" });
    req.browser = { profile: "acct", allow_domains: ["example.com"] };
    const shared = await host.ensureProfileBrowser({
      runId: req.runId,
      browser: req.browser,
      profile: req.profile!,
      runner: anchorRunner(),
    });
    expect(shared.anchorEnv.AGENT_BROWSER_PROFILE).toBe(req.profile!.profileDir);
    expect(shared.anchorEnv.AGENT_BROWSER_SESSION).toBe("sf-acct");
    expect(shared.anchorEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("0");
    const env = await stageEnvOf(host, req);
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(env.AGENT_BROWSER_SESSION).toMatch(/^sf-acct-[0-9a-f]{6}$/);
    for (const e of [env, shared.anchorEnv]) {
      expect(e).not.toHaveProperty("AGENT_BROWSER_ALLOWED_DOMAINS");
    }
  });

  it("a human login request makes a headless anchor headed again", async () => {
    const { host, profiles } = local();
    const req = await request(profiles, { profileName: "acct" });
    req.browser = { profile: "acct", headed: false };
    const calls: string[][] = [];
    const base = { runId: req.runId, browser: req.browser, profile: req.profile!, runner: anchorRunner(calls) };
    const headless = await host.ensureProfileBrowser(base);
    expect(headless.anchorEnv.AGENT_BROWSER_HEADED).toBe("0");
    const headed = await host.ensureProfileBrowser({ ...base, humanLogin: true, previous: headless });
    expect(headed.anchorEnv.AGENT_BROWSER_HEADED).toBe("1");
    expect(headed.restarted).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["open", "get", "close", "open", "get"]);
  });

  it("profile-less stage: no profile, allowlist set", async () => {
    const { host, profiles } = local();
    const req = await request(profiles);
    req.browser = { allow_domains: ["example.com", "*.example.com"] };
    const env = await stageEnvOf(host, req);
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("example.com,*.example.com");
  });

  it("pins agent-browser config to an empty file", async () => {
    const { host, profiles } = local();
    const env = await stageEnvOf(host, await request(profiles));
    expect(JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG!, "utf8"))).toEqual({});
  });

  it("socket path stays under 103 bytes with a long profile name and deep home", async () => {
    const deep = path.join(home, "a".repeat(60), "b".repeat(60), "c".repeat(60));
    process.env.STAGEFLOW_HOME = deep;
    resetGlobalStageflowHomeForTests();
    const { host, profiles } = local();
    const req = await request(profiles, { profileName: "p".repeat(64) });
    const env = await stageEnvOf(host, req);
    const shared = await host.ensureProfileBrowser({
      runId: req.runId,
      browser: req.browser,
      profile: req.profile!,
      runner: anchorRunner(),
    });
    for (const e of [env, shared.anchorEnv]) {
      const sock = path.join(e.AGENT_BROWSER_SOCKET_DIR!, `${e.AGENT_BROWSER_SESSION}.sock`);
      expect(Buffer.byteLength(sock)).toBeLessThan(103);
      expect(e.AGENT_BROWSER_SOCKET_DIR!.startsWith(deep)).toBe(false);
    }
  });

  it("is headed by default and headless when the stage says so", async () => {
    const { host, profiles } = local();
    expect((await stageEnvOf(host, await request(profiles))).AGENT_BROWSER_HEADED).toBe("1");
    const req = await request(profiles);
    req.browser = { headed: false };
    expect((await stageEnvOf(host, req)).AGENT_BROWSER_HEADED).toBe("0");
  });

  it("falls back to headless on Linux without a display", async () => {
    const { host, profiles } = local({ platform: "linux", hostEnv: {} });
    const env = await stageEnvOf(host, await request(profiles));
    expect(env.AGENT_BROWSER_HEADED).toBe("0");
  });

  it("stays headed on Linux with a display and passes it through", async () => {
    const { host, profiles } = local({
      platform: "linux",
      hostEnv: { DISPLAY: ":1", XAUTHORITY: "/home/u/.Xauthority" },
    });
    const env = await stageEnvOf(host, await request(profiles));
    expect(env.AGENT_BROWSER_HEADED).toBe("1");
    expect(env.DISPLAY).toBe(":1");
    expect(env.XAUTHORITY).toBe("/home/u/.Xauthority");
  });
});

describe("virtual display and launch options", () => {
  const xvfb = (found: boolean) => () => found;
  const local = (opts: Parameters<typeof createLocalBrowserHost>[0]) => ({
    host: createLocalBrowserHost({ socketRoot: sockRoot, ...opts }),
    profiles: createLocalProfileStore(),
  });
  const display = (opts: Parameters<typeof createLocalBrowserHost>[0]) =>
    resolveBrowserHostCapabilities(createLocalBrowserHost({ socketRoot: sockRoot, ...opts }).capabilities)
      .display;

  it("derives display from platform, display variables and Xvfb", () => {
    expect(display({ platform: "darwin", hostEnv: {}, xvfbProbe: xvfb(true) })).toBe("local_window");
    expect(display({ platform: "win32", hostEnv: {}, xvfbProbe: xvfb(true) })).toBe("local_window");
    expect(display({ platform: "linux", hostEnv: { DISPLAY: ":1" }, xvfbProbe: xvfb(true) })).toBe("local_window");
    expect(display({ platform: "linux", hostEnv: { WAYLAND_DISPLAY: "w-0" }, xvfbProbe: xvfb(true) })).toBe("local_window");
    expect(display({ platform: "linux", hostEnv: {}, xvfbProbe: xvfb(true) })).toBe("virtual_display");
    expect(display({ platform: "linux", hostEnv: {}, xvfbProbe: xvfb(false) })).toBe("headless_only");
  });

  it("default probe finds Xvfb on PATH without spawning", async () => {
    const bin = await mkdtemp(path.join("/tmp", "sfbt-bin-"));
    try {
      expect(display({ platform: "linux", hostEnv: { PATH: bin } })).toBe("headless_only");
      await writeFile(path.join(bin, "Xvfb"), "#!/bin/sh\n", { mode: 0o755 });
      expect(display({ platform: "linux", hostEnv: { PATH: `/nonexistent:${bin}` } })).toBe("virtual_display");
      await chmod(path.join(bin, "Xvfb"), 0o644);
      expect(display({ platform: "linux", hostEnv: { PATH: bin } })).toBe("headless_only");
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("virtual display is headed without display variables; headed:false is honored", async () => {
    const { host, profiles } = local({
      platform: "linux",
      hostEnv: { XAUTHORITY: "/stale/.Xauthority" },
      xvfbProbe: xvfb(true),
    });
    const env = await stageEnvOf(host, await request(profiles));
    expect(env.AGENT_BROWSER_HEADED).toBe("1");
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) expect(env).not.toHaveProperty(name);
    const req = await request(profiles);
    req.browser = { headed: false };
    expect((await stageEnvOf(host, req)).AGENT_BROWSER_HEADED).toBe("0");
  });

  it("headless-only Linux stays headless; local window copies display variables", async () => {
    const none = local({ platform: "linux", hostEnv: {}, xvfbProbe: xvfb(false) });
    expect((await stageEnvOf(none.host, await request(none.profiles))).AGENT_BROWSER_HEADED).toBe("0");
    const win = local({
      platform: "linux",
      hostEnv: { DISPLAY: ":1", WAYLAND_DISPLAY: "w-0", XAUTHORITY: "/x" },
      xvfbProbe: xvfb(true),
    });
    const env = await stageEnvOf(win.host, await request(win.profiles));
    expect(env).toMatchObject({ AGENT_BROWSER_HEADED: "1", DISPLAY: ":1", WAYLAND_DISPLAY: "w-0", XAUTHORITY: "/x" });
  });

  const launch = {
    launchArgs: ["--no-sandbox", "--use-gl=angle"],
    executablePath: "/usr/bin/chromium",
  };

  it("launch options reach sessions that launch Chrome and not a CDP attach", async () => {
    const { host, profiles } = local({
      platform: "darwin",
      hostEnv: { AGENT_BROWSER_ARGS: "--ambient", AGENT_BROWSER_EXECUTABLE_PATH: "/ambient" },
      ...launch,
    });
    const req = await request(profiles, { profileName: "acct" });
    const anchor = await host.profileBrowserEnv({ runId: req.runId, browser: req.browser, profile: req.profile! });
    const again = await host.profileBrowserEnv({ runId: req.runId, browser: req.browser, profile: req.profile! });
    expect(anchor.AGENT_BROWSER_ARGS).toBe("--deny-permission-prompts,--no-sandbox,--use-gl=angle");
    expect(anchor.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/chromium");
    expect(JSON.stringify(again)).toBe(JSON.stringify(anchor));
    const attached = await stageEnvOf(host, req);
    expect(attached).not.toHaveProperty("AGENT_BROWSER_ARGS");
    expect(attached).not.toHaveProperty("AGENT_BROWSER_EXECUTABLE_PATH");
    const plainReq = await request(profiles);
    const plain = await host.stageEnv(plainReq);
    expect(plain.AGENT_BROWSER_ARGS).toBe("--deny-permission-prompts,--no-sandbox,--use-gl=angle");
    expect(plain.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/chromium");
    expect(JSON.stringify(await host.stageEnv(plainReq))).toBe(JSON.stringify(plain));
  });

  it("denies permission prompts by default in launching sessions only, and ignores ambient AGENT_BROWSER_*", async () => {
    const { host, profiles } = local({
      platform: "darwin",
      hostEnv: { AGENT_BROWSER_ARGS: "--ambient", AGENT_BROWSER_EXECUTABLE_PATH: "/ambient" },
    });
    const req = await request(profiles, { profileName: "acct" });
    const anchor = await host.profileBrowserEnv({ runId: req.runId, browser: req.browser, profile: req.profile! });
    expect(anchor.AGENT_BROWSER_ARGS).toBe("--deny-permission-prompts");
    expect((await host.stageEnv(await request(profiles))).AGENT_BROWSER_ARGS).toBe("--deny-permission-prompts");
    expect(await stageEnvOf(host, req)).not.toHaveProperty("AGENT_BROWSER_ARGS");
    const env = await host.stageEnv(await request(profiles));
    expect(env).not.toHaveProperty("AGENT_BROWSER_EXECUTABLE_PATH");
  });

  it("does not repeat the deny switch when the operator lists it", async () => {
    const { host, profiles } = local({
      platform: "darwin",
      launchArgs: ["--no-sandbox", "--deny-permission-prompts"],
    });
    const env = await host.stageEnv(await request(profiles));
    expect(env.AGENT_BROWSER_ARGS).toBe("--deny-permission-prompts,--no-sandbox");
  });
});

describe("host capability derivation", () => {
  const caps = (opts: Parameters<typeof createLocalBrowserHost>[0]) =>
    resolveBrowserHostCapabilities(createLocalBrowserHost({ socketRoot: sockRoot, ...opts }).capabilities);

  it.each(["darwin", "win32"] as const)("%s reports a local window", (platform) => {
    expect(caps({ platform, hostEnv: {} }).display).toBe("local_window");
  });

  it("linux with DISPLAY or WAYLAND_DISPLAY reports a local window", () => {
    expect(caps({ platform: "linux", hostEnv: { DISPLAY: ":1" } }).display).toBe("local_window");
    expect(caps({ platform: "linux", hostEnv: { WAYLAND_DISPLAY: "wayland-0" } }).display).toBe("local_window");
  });

  it("linux without a display or Xvfb is headless only", () => {
    const c = caps({ platform: "linux", hostEnv: {}, xvfbProbe: () => false });
    expect(c.display).toBe("headless_only");
    expect(c.liveView).toBe("none");
  });

  it("reports no live view unless the relay option is set", () => {
    expect(caps({ platform: "linux", hostEnv: {}, liveView: "none" }).liveView).toBe("none");
    const relay = caps({ platform: "linux", hostEnv: {}, liveView: "relay" });
    expect(relay.liveView).toBe("relay");
    expect(relay.display).toBe("headless_only");
    const desktop = caps({ platform: "darwin", hostEnv: {}, liveView: "relay" });
    expect(desktop.display).toBe("local_window");
    expect(desktop.liveView).toBe("relay");
  });

  it("fake remote host defaults to CDP attach with no display claims, and is configurable", () => {
    const def = resolveBrowserHostCapabilities(createFakeRemoteBrowserHost("ws://x").capabilities);
    expect(def.attach).toBe("cdp");
    expect(def.display).toBe("headless_only");
    const custom = resolveBrowserHostCapabilities(
      createFakeRemoteBrowserHost("ws://x", { display: "virtual_display", liveView: "relay" }).capabilities,
    );
    expect(custom.display).toBe("virtual_display");
    expect(custom.liveView).toBe("relay");
  });
});
