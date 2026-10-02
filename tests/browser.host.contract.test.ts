import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserHost,
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

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "sf-browser-host-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(home, { recursive: true, force: true });
});

const implementations: Array<{
  name: string;
  make: () => { host: BrowserHost; profiles: ProfileStore };
  remote: boolean;
}> = [
  {
    name: "local",
    make: () => ({
      host: createLocalBrowserHost({ platform: "darwin", hostEnv: {} }),
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

describe.each(implementations)("BrowserHost contract: $name", ({ make, remote }) => {
  it("returns identical env for identical requests", async () => {
    const { host, profiles } = make();
    const req = await request(profiles, { profileName: "acct" });
    expect(await host.stageEnv(req)).toEqual(await host.stageEnv(req));
  });

  it("returns only string values and disables the idle timeout", async () => {
    const { host, profiles } = make();
    const env = await host.stageEnv(await request(profiles, { profileName: "acct" }));
    for (const value of Object.values(env)) expect(typeof value).toBe("string");
    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("0");
    expect(env.AGENT_BROWSER_SESSION).toBeTruthy();
  });

  it("shares one session between stages that name the same profile", async () => {
    const { host, profiles } = make();
    const a = await host.stageEnv(
      await request(profiles, { profileName: "acct", stageId: "one" }),
    );
    const b = await host.stageEnv(
      await request(profiles, { profileName: "acct", stageId: "two", runId: "run-2" }),
    );
    expect(a.AGENT_BROWSER_SESSION).toBe(b.AGENT_BROWSER_SESSION);
    const other = await host.stageEnv(await request(profiles, { profileName: "other" }));
    expect(other.AGENT_BROWSER_SESSION).not.toBe(a.AGENT_BROWSER_SESSION);
  });

  it("gives profile-less stages distinct sessions per run and stage", async () => {
    const { host, profiles } = make();
    const base = await host.stageEnv(await request(profiles));
    const otherStage = await host.stageEnv(await request(profiles, { stageId: "stage-b" }));
    const otherRun = await host.stageEnv(await request(profiles, { runId: "run-2" }));
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
      const env = await host.stageEnv(await request(profiles, { profileName: "acct" }));
      expect(env.AGENT_BROWSER_SESSION).not.toBe("ambient");
      expect(env.AGENT_BROWSER_PROFILE).not.toBe("/ambient/profile");
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
      const env = await host.stageEnv(req);
      expect(env.AGENT_BROWSER_CDP).toBe("wss://browsers.example/session-1");
      expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
      expect(JSON.stringify(env)).not.toContain(req.profile!.profileDir);
    });
  } else {
    it("gives the stage the profile dir and no remote address", async () => {
      const { host, profiles } = make();
      const req = await request(profiles, { profileName: "acct" });
      const env = await host.stageEnv(req);
      expect(env.AGENT_BROWSER_PROFILE).toBe(req.profile!.profileDir);
      expect(env).not.toHaveProperty("AGENT_BROWSER_CDP");
    });
  }
});

describe("local BrowserHost settings", () => {
  const local = (opts: Parameters<typeof createLocalBrowserHost>[0] = {}) => ({
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, ...opts }),
    profiles: createLocalProfileStore(),
  });

  it("profile stage: profile and session set, allowlist omitted", async () => {
    const { host, profiles } = local();
    const req = await request(profiles, { profileName: "acct" });
    req.browser = { profile: "acct", allow_domains: ["example.com"] };
    const env = await host.stageEnv(req);
    expect(env.AGENT_BROWSER_PROFILE).toBe(req.profile!.profileDir);
    expect(env.AGENT_BROWSER_SESSION).toBe("sf-acct");
    expect(env).not.toHaveProperty("AGENT_BROWSER_ALLOWED_DOMAINS");
  });

  it("profile-less stage: no profile, allowlist set", async () => {
    const { host, profiles } = local();
    const req = await request(profiles);
    req.browser = { allow_domains: ["example.com", "*.example.com"] };
    const env = await host.stageEnv(req);
    expect(env).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("example.com,*.example.com");
  });

  it("pins agent-browser config to an empty file", async () => {
    const { host, profiles } = local();
    const env = await host.stageEnv(await request(profiles));
    expect(JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG!, "utf8"))).toEqual({});
  });

  it("socket path stays under 103 bytes with a long profile name and deep home", async () => {
    const deep = path.join(home, "a".repeat(60), "b".repeat(60), "c".repeat(60));
    process.env.STAGEFLOW_HOME = deep;
    resetGlobalStageflowHomeForTests();
    const { host, profiles } = local();
    const req = await request(profiles, { profileName: "p".repeat(64) });
    const env = await host.stageEnv(req);
    const sock = path.join(env.AGENT_BROWSER_SOCKET_DIR!, `${env.AGENT_BROWSER_SESSION}.sock`);
    expect(Buffer.byteLength(sock)).toBeLessThan(103);
    expect(env.AGENT_BROWSER_SOCKET_DIR!.startsWith(deep)).toBe(false);
  });

  it("is headed by default and headless when the stage says so", async () => {
    const { host, profiles } = local();
    expect((await host.stageEnv(await request(profiles))).AGENT_BROWSER_HEADED).toBe("1");
    const req = await request(profiles);
    req.browser = { headed: false };
    expect((await host.stageEnv(req)).AGENT_BROWSER_HEADED).toBe("0");
  });

  it("falls back to headless on Linux without a display", async () => {
    const { host, profiles } = local({ platform: "linux", hostEnv: {} });
    const env = await host.stageEnv(await request(profiles));
    expect(env.AGENT_BROWSER_HEADED).toBe("0");
  });

  it("stays headed on Linux with a display and passes it through", async () => {
    const { host, profiles } = local({
      platform: "linux",
      hostEnv: { DISPLAY: ":1", XAUTHORITY: "/home/u/.Xauthority" },
    });
    const env = await host.stageEnv(await request(profiles));
    expect(env.AGENT_BROWSER_HEADED).toBe("1");
    expect(env.DISPLAY).toBe(":1");
    expect(env.XAUTHORITY).toBe("/home/u/.Xauthority");
  });
});
