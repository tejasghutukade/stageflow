import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRunProfileBrowser } from "../src/browser/anchor.js";
import { createMemoryAuditSink } from "../src/browser/auditSink.js";
import { sweepOrphanBrowserSessions } from "../src/browser/browserSweep.js";
import { teardownRunBrowsers, teardownStageBrowser } from "../src/browser/browserTeardown.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { resolveStageBrowserEnv } from "../src/browser/stageBrowserEnv.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { resolveBrowserHostCapabilities } from "../src/browser/hostCapabilities.js";
import {
  createPlatformBrowserClient,
  createPlatformBrowserHost,
  type PlatformBrowserClient,
  PlatformBrowserError,
  platformBrowserHostFromEnv,
} from "../src/browser/platformBrowserHost.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { loadHostConfig } from "../src/config/hostConfig.js";
import { execInSandboxContainer, sandboxBrowserEnv } from "../src/runtime/sandboxContainer.js";
import { FOREVER_DENIED_SECRET_NAMES } from "../src/runtime/stageEnvironment.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join("/tmp", "sfph-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

function fakeClient() {
  const calls: Array<[string, unknown]> = [];
  let next = 0;
  const client: PlatformBrowserClient = {
    async createSession(input) {
      calls.push(["create", input]);
      return { connectUrl: `wss://connect.example/?signingKey=k${++next}` };
    },
    async release(input) {
      calls.push(["release", input]);
    },
    async runs() {
      return ["live-run", "dead-run"];
    },
  };
  return { client, calls };
}

function setup() {
  const { client, calls } = fakeClient();
  const host = createPlatformBrowserHost({ client, local: { platform: "linux", hostEnv: {}, socketRoot: path.join(root, "sock"), emptyConfigPath: path.join(root, "empty.json") } });
  const profiles = createVolumeProfileStore();
  const request = async (extra: Record<string, unknown> = {}) => ({
    runId: "run-1",
    browser: { profile: "acct" },
    profile: await profiles.open({ scope: "local", name: "acct" }),
    runner: (async () => {
      throw new Error("the platform host must not drive a local browser");
    }) as BrowserRunner,
    ...extra,
  });
  return { host, calls, request, profiles };
}

describe("platform browser host", () => {
  it("reports a remote CDP host whose logins the platform keeps and whose allowlist is hard", () => {
    const caps = resolveBrowserHostCapabilities(setup().host.capabilities);
    expect(caps).toMatchObject({ attach: "cdp", profilePersistence: "provider_managed", hardAllowlist: true, liveView: "none", display: "headless_only" });
  });

  it("asks the platform for the run's profile browser once and reuses the persisted one", async () => {
    const { host, calls, request } = setup();
    const shared = await host.ensureProfileBrowser(await request());
    expect(calls).toEqual([["create", { runId: "run-1", profile: "acct" }]]);
    expect(shared.cdpAddress).toBe("wss://connect.example/?signingKey=k1");
    expect(shared.anchorEnv.AGENT_BROWSER_CDP).toBe(shared.cdpAddress);
    expect(shared.anchorEnv.AGENT_BROWSER_PIN_TAB).toBeUndefined();
    expect(shared.anchorEnv.AGENT_BROWSER_PROFILE).toBeUndefined();
    const again = await host.ensureProfileBrowser(await request({ previous: shared }));
    expect(again).toEqual({ ...shared, restarted: false });
    expect(calls).toHaveLength(1);
  });

  it("refuses a human login, which needs a live view this host does not offer yet", async () => {
    const { host, request } = setup();
    await expect(host.ensureProfileBrowser(await request({ humanLogin: true }))).rejects.toMatchObject({ code: "platform_no_human_login" });
  });

  it("gives a profile stage a pinned tab in the run's browser and a profile-less stage its own remote browser", async () => {
    const { host, calls, profiles } = setup();
    const profile = await profiles.open({ scope: "local", name: "acct" });
    const tab = await host.stageEnv({ runId: "run-1", stageId: "work", browser: { profile: "acct" }, profile, cdpAddress: "wss://connect.example/?signingKey=anchor" });
    expect(tab).toMatchObject({ AGENT_BROWSER_CDP: "wss://connect.example/?signingKey=anchor", AGENT_BROWSER_PIN_TAB: "1" });
    expect(calls).toHaveLength(0);

    const own = await host.stageEnv({ runId: "run-1", stageId: "scrape", browser: { allow_domains: ["example.com"] } });
    expect(calls).toEqual([["create", { runId: "run-1", stageId: "scrape", allowDomains: ["example.com"] }]]);
    expect(own.AGENT_BROWSER_CDP).toBe("wss://connect.example/?signingKey=k1");
    for (const key of ["AGENT_BROWSER_ARGS", "AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_ALLOWED_DOMAINS", "AGENT_BROWSER_HEADED", "AGENT_BROWSER_PROFILE"]) expect(own[key]).toBeUndefined();
    expect(own.AGENT_BROWSER_SESSION).toMatch(/^sf-t-/);
  });

  it("releases a profile-less stage's browser and the run's profile browser, and sweeps runs that are gone", async () => {
    const { host, calls } = setup();
    await host.releaseStageBrowser!({ scope: "local", runId: "run-1", stageId: "work", shared: true });
    expect(calls).toHaveLength(0);
    await host.releaseStageBrowser!({ scope: "local", runId: "run-1", stageId: "scrape", shared: false });
    await host.releaseProfileBrowser!({ scope: "local", runId: "run-1", profile: "acct" });
    expect(calls).toEqual([["release", { runId: "run-1", stageId: "scrape" }], ["release", { runId: "run-1", profile: "acct" }]]);
    const swept = await host.sweepOrphans!({ isRunLive: async (id) => id === "live-run" });
    expect(swept).toEqual({ released: ["dead-run"] });
    expect(calls.at(-1)).toEqual(["release", { runId: "dead-run" }]);
  });
});

describe("platform browser host in the Host's browser lifecycle", () => {
  it("creates a stage's own browser at stage start, releases it at stage end, and releases the run's profile browser at run end", async () => {
    const { client, calls } = fakeClient();
    const runnerCalls: string[][] = [];
    const runner: BrowserRunner = async (args) => {
      runnerCalls.push(args);
      return { code: 0, stdout: "" };
    };
    const host = createPlatformBrowserHost({ client, local: { platform: "linux", hostEnv: {}, socketRoot: path.join(root, "sock") } });
    const support: StageBrowserSupport = {
      host, profiles: createVolumeProfileStore(), runner, socketRoot: path.join(root, "sock"),
      locks: createInMemoryProfileLock(), closeWaitMs: 30, blockedSites: [], audit: createMemoryAuditSink(),
    };
    const runDir = path.join(root, "run");
    const env = await resolveStageBrowserEnv(support, { runId: "run-1", stageId: "scrape", scope: "local", runDir, browser: { allow_domains: ["example.com"] } });
    expect(env?.AGENT_BROWSER_CDP).toBe("wss://connect.example/?signingKey=k1");
    expect(calls).toEqual([["create", { runId: "run-1", stageId: "scrape", allowDomains: ["example.com"] }]]);

    await teardownStageBrowser(support, { runId: "run-1", runDir, stageId: "scrape" });
    expect(calls.at(-1)).toEqual(["release", { runId: "run-1", stageId: "scrape" }]);
    expect(runnerCalls.some((args) => args[0] === "close")).toBe(true);
    await teardownStageBrowser(support, { runId: "run-1", runDir, stageId: "scrape" });
    expect(calls.filter(([kind]) => kind === "release")).toHaveLength(1);

    const profile = await support.profiles.open({ scope: "local", name: "acct" });
    await ensureRunProfileBrowser(support, { runId: "run-1", runDir, browser: { profile: "acct" }, profile });
    await teardownRunBrowsers(support, { runId: "run-1", runDir });
    expect(calls.at(-1)).toEqual(["release", { runId: "run-1", profile: "acct" }]);

    const swept = await sweepOrphanBrowserSessions({ isRunLive: async (id) => id === "live-run", host, runner, closeWaitMs: 30, socketRoot: path.join(root, "sock") });
    expect(swept.released).toContain("dead-run");
  });
});

describe("platform browser client", () => {
  it("sends only the bearer token and maps platform errors to codes without the token", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let answer: { status: number; body: unknown } = { status: 201, body: { sessionId: "s1", connectUrl: "wss://c/?signingKey=x" } };
    const client = createPlatformBrowserClient({
      url: "https://gw.example.run.app/",
      token: "ws-id.secret-mac-value",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }) as typeof fetch,
    });
    expect(await client.createSession({ runId: "r1", stageId: "s" })).toEqual({ connectUrl: "wss://c/?signingKey=x" });
    expect(seen[0]!.url).toBe("https://gw.example.run.app/_gw/host/browser/sessions");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer ws-id.secret-mac-value");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ runId: "r1", stageId: "s" });

    answer = { status: 429, body: { error: "browser_capacity" } };
    const busy = await client.createSession({ runId: "r1" }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(PlatformBrowserError);
    expect(busy).toMatchObject({ code: "browser_capacity" });
    expect(String((busy as Error).message)).not.toContain("secret-mac-value");

    answer = { status: 502, body: { error: "<script>" } };
    await expect(client.release({ runId: "r1" })).rejects.toMatchObject({ code: "platform_http_502" });
    answer = { status: 201, body: { connectUrl: "http://not-cdp" } };
    await expect(client.createSession({ runId: "r1" })).rejects.toMatchObject({ code: "platform_bad_answer" });
  });

  it("never hands the platform token to a stage", () => {
    expect(FOREVER_DENIED_SECRET_NAMES.has("STAGEFLOW_PLATFORM_TOKEN")).toBe(true);
  });

  it("is built from the Host env only when both settings are present", () => {
    expect(platformBrowserHostFromEnv({})).toBeUndefined();
    expect(platformBrowserHostFromEnv({ STAGEFLOW_PLATFORM_URL: "https://gw" })).toBeUndefined();
    expect(platformBrowserHostFromEnv({ STAGEFLOW_PLATFORM_URL: "https://gw", STAGEFLOW_PLATFORM_TOKEN: "t".repeat(40) })).toBeDefined();
  });

  it("makes platform the default browser host when the platform address is set, unless config says otherwise", async () => {
    expect(loadHostConfig({ env: { STAGEFLOW_PLATFORM_URL: "https://gw" }, configFilePath: null }).browserHost).toBe("platform");
    expect(loadHostConfig({ env: {}, configFilePath: null }).browserHost).toBe("local");
    const file = path.join(root, "config.yaml");
    await writeFile(file, "browser:\n  host: local\n");
    expect(loadHostConfig({ env: { STAGEFLOW_PLATFORM_URL: "https://gw" }, configFilePath: file }).browserHost).toBe("local");
    await writeFile(file, "browser:\n  host: platform\n");
    expect(loadHostConfig({ env: {}, configFilePath: file }).browserHost).toBe("platform");
  });
});

describe("browser env inside the stage sandbox", () => {
  it("passes only a remote browser's settings, with socket and config moved to sandbox paths", () => {
    expect(sandboxBrowserEnv({})).toBeUndefined();
    expect(sandboxBrowserEnv({ AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/x" })).toBeUndefined();
    expect(sandboxBrowserEnv({ AGENT_BROWSER_CDP: "ws://localhost:9222" })).toBeUndefined();
    expect(
      sandboxBrowserEnv({
        AGENT_BROWSER_CDP: "wss://connect.example/?signingKey=k",
        AGENT_BROWSER_SESSION: "sf-t-abc",
        AGENT_BROWSER_SOCKET_DIR: "/data/sfhome/tmp/ab/1a2b3c4d",
        AGENT_BROWSER_CONFIG: "/data/sfhome/browser/agent-browser.empty.json",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
        AGENT_BROWSER_PROFILE: "/never",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      AGENT_BROWSER_CDP: "wss://connect.example/?signingKey=k",
      AGENT_BROWSER_SESSION: "sf-t-abc",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AGENT_BROWSER_SOCKET_DIR: "/tmp/sf-agent-browser/1a2b3c4d",
      AGENT_BROWSER_CONFIG: "/tmp/sf-agent-browser/empty.json",
    });
  });

  it("hands the values to docker exec by name, never on its command line, and creates the empty config first", async () => {
    const docker = path.join(root, "docker");
    const out = path.join(root, "out.txt");
    await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\nprintf 'CDP=%s\\n' "$AGENT_BROWSER_CDP" >> ${out}\n`);
    await chmod(docker, 0o755);
    await execInSandboxContainer({ containerName: "c1", command: "agent-browser get url", dockerBin: docker, env: { AGENT_BROWSER_CDP: "wss://secret-signing", AGENT_BROWSER_CONFIG: "/tmp/sf-agent-browser/empty.json" } });
    const lines = (await readFile(out, "utf8")).split("\n");
    const args = lines.slice(0, lines.findIndex((l) => l.startsWith("CDP=")));
    expect(args.slice(0, 5)).toEqual(["exec", "-e", "AGENT_BROWSER_CDP", "-e", "AGENT_BROWSER_CONFIG"]);
    expect(args.join("\n")).not.toContain("secret-signing");
    expect(args.join("\n")).toContain("printf '{}\\n' > /tmp/sf-agent-browser/empty.json");
    expect(args.join("\n")).toContain("agent-browser get url");
    expect(lines).toContain("CDP=wss://secret-signing");
  });
});
