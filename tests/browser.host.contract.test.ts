import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserHost,
  type BrowserRunner,
  type BrowserStageRequest,
} from "../src/browser/browserHost.js";
import { createFakeRemoteBrowserHost } from "../src/browser/fakeRemoteBrowserHost.js";
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

describe.each(implementations)("BrowserHost contract: $name", ({ make, remote }) => {
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
      expect(env.AGENT_BROWSER_CDP).toBe("wss://browsers.example/session-1");
      expect(env.AGENT_BROWSER_PIN_TAB).toBe("1");
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(JSON.stringify(env)).not.toContain(req.profile!.profileDir);
    });
  } else {
    it("attaches the stage to the local anchor address and keeps the profile dir off the stage", async () => {
      const { host, profiles } = make();
      const req = await request(profiles, { profileName: "acct" });
      const env = await stageEnvOf(host, req);
      expect(env.AGENT_BROWSER_CDP).toBe(CDP);
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(JSON.stringify(env)).not.toContain(req.profile!.profileDir);
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
