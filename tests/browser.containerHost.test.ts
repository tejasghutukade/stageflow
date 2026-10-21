import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRunProfileBrowser, readPersistedAnchor } from "../src/browser/anchor.js";
import { sweepOrphanBrowserSessions } from "../src/browser/browserSweep.js";
import { teardownRunBrowsers } from "../src/browser/browserTeardown.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createContainerBrowserHost } from "../src/browser/containerBrowserHost.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { createInMemoryProfileLock } from "../src/browser/memoryProfileLock.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createFakeContainerBrowsers } from "./helpers/fakeContainerBrowsers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join("/tmp", "sfch-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

const runner: BrowserRunner = async () => ({ code: 0, stdout: "" });

function setup(options: { closeWaitMs?: number; startTimeoutMs?: number } = {}) {
  const fake = createFakeContainerBrowsers();
  const host = createContainerBrowserHost({
    orchestrator: fake.orchestrator,
    endpoint: fake.endpoint,
    local: { platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") },
    pollMs: 1,
    closeWaitMs: options.closeWaitMs ?? 30,
    startTimeoutMs: options.startTimeoutMs ?? 30,
  });
  const profiles = createVolumeProfileStore();
  const support: StageBrowserSupport = {
    host,
    profiles,
    runner,
    socketRoot: path.join(root, "sock"),
    locks: createInMemoryProfileLock(),
    closeWaitMs: 50,
  };
  const request = async (runId = "run-1", name = "acct") => ({
    runId,
    browser: { profile: name },
    profile: await profiles.open({ scope: "local", name }),
    runner,
  });
  return { fake, host, profiles, support, request };
}

describe("container browser host", () => {
  it("starts one labelled container per (scope, profile, run) with the profile volume and no profile folder", async () => {
    const { fake, host, request } = setup();
    const req = await request();
    const shared = await host.ensureProfileBrowser(req);
    expect(shared.cdpAddress).toBe(fake.addressOf(1));
    expect(shared.restarted).toBe(false);
    expect(req.profile.profileDir).toBeUndefined();
    expect(req.profile.volumeRef).toBe("local/acct");
    expect(shared.anchorEnv.AGENT_BROWSER_CDP).toBe(fake.addressOf(1));
    expect(shared.anchorEnv).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(shared.anchorEnv).not.toHaveProperty("AGENT_BROWSER_PIN_TAB");
    const listed = await fake.orchestrator.listByLabel({ scope: "local", runId: "run-1", profile: "acct" });
    expect(listed).toHaveLength(1);
    await host.ensureProfileBrowser({ ...(await request("run-2")) });
    expect(await fake.orchestrator.listByLabel({ scope: "local" })).toHaveLength(2);
  });

  it("keeps containers, volumes and release of two owner scopes apart", async () => {
    const { fake, host, profiles } = setup();
    const mk = async (scope: string) => ({
      runId: "run-1",
      browser: { profile: "acct" },
      profile: await profiles.open({ scope, name: "acct" }),
      runner,
    });
    const a = await mk("tenant-a");
    const b = await mk("tenant-b");
    expect(a.profile.volumeRef).toBe("tenant-a/acct");
    expect(b.profile.volumeRef).toBe("tenant-b/acct");
    await host.ensureProfileBrowser(a);
    await host.ensureProfileBrowser(b);
    expect(await fake.orchestrator.listByLabel({ scope: "tenant-a" })).toHaveLength(1);
    expect(await fake.orchestrator.listByLabel({ scope: "tenant-b" })).toHaveLength(1);
    await host.releaseProfileBrowser!({ scope: "tenant-a", runId: "run-1", profile: "acct" });
    expect(await fake.orchestrator.listByLabel({ scope: "tenant-a" })).toHaveLength(0);
    expect(await fake.orchestrator.listByLabel({ scope: "tenant-b" })).toHaveLength(1);
  });

  it("reuses a live previous anchor without starting another container", async () => {
    const { fake, host, request } = setup();
    const first = await host.ensureProfileBrowser(await request());
    const again = await host.ensureProfileBrowser({ ...(await request()), previous: first });
    expect(again).toEqual({ ...first, restarted: false });
    expect(await fake.orchestrator.listByLabel({})).toHaveLength(1);
  });

  it("replaces a crashed container, reports a restarted anchor, and removes the dead one", async () => {
    const { fake, host, request } = setup();
    const first = await host.ensureProfileBrowser(await request());
    fake.crash(1);
    const second = await host.ensureProfileBrowser({ ...(await request()), previous: first });
    expect(second.restarted).toBe(true);
    expect(second.cdpAddress).toBe(fake.addressOf(2));
    expect(second.anchorEnv.AGENT_BROWSER_CDP).toBe(fake.addressOf(2));
    expect(fake.events).toContain("release:sbx-1");
    expect((await fake.orchestrator.listByLabel({})).map((i) => i.ref.id)).toEqual(["sbx-2"]);
  });

  it("adopts a running container it has no record of (Host restart before the anchor was saved)", async () => {
    const { fake, host, request } = setup();
    const first = await host.ensureProfileBrowser(await request());
    const adopted = await host.ensureProfileBrowser(await request());
    expect(adopted.cdpAddress).toBe(first.cdpAddress);
    expect(adopted.restarted).toBe(false);
    expect(await fake.orchestrator.listByLabel({})).toHaveLength(1);
  });

  it("gives up and releases a container whose debugging port never answers", async () => {
    const { fake, host, request } = setup({ startTimeoutMs: 20 });
    fake.endpoint.resolve = async () => undefined;
    await expect(host.ensureProfileBrowser(await request())).rejects.toThrow(/did not answer/);
    expect(await fake.orchestrator.listByLabel({})).toEqual([]);
  });

  it("resolves a non-IP attach host to an IP before probing", async () => {
    const fake = createFakeContainerBrowsers();
    const probed: string[] = [];
    const host = createContainerBrowserHost({
      orchestrator: {
        ...fake.orchestrator,
        start: async (r) => ({ ...(await fake.orchestrator.start(r)), attachAddress: "http://browser.internal:9222" }),
      },
      endpoint: {
        resolve: async (endpoint) => {
          probed.push(endpoint);
          return "ws://10.0.0.7:9222/devtools/browser/x";
        },
        closeBrowser: async () => undefined,
      },
      resolveHost: async () => "10.0.0.7",
      local: { platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") },
    });
    const profiles = createVolumeProfileStore();
    await host.ensureProfileBrowser({
      runId: "r",
      browser: { profile: "acct" },
      profile: await profiles.open({ scope: "local", name: "acct" }),
      runner,
    });
    expect(probed).toEqual(["http://10.0.0.7:9222"]);
  });

  it("closes the browser gracefully, then releases through the orchestrator without a forced stop", async () => {
    const { fake, host, request } = setup();
    await host.ensureProfileBrowser(await request());
    await host.releaseProfileBrowser!({ scope: "local", runId: "run-1", profile: "acct" });
    expect(fake.events).toEqual(["close:1", "release:sbx-1"]);
    expect(await fake.orchestrator.listByLabel({})).toEqual([]);
  });

  it("stops the container when the browser ignores the graceful close, bounded", async () => {
    const { fake, host, request } = setup({ closeWaitMs: 20 });
    fake.ignoreClose();
    await host.ensureProfileBrowser(await request());
    await host.releaseProfileBrowser!({ scope: "local", runId: "run-1", profile: "acct" });
    expect(fake.events).toEqual(["close:1", "stop:sbx-1", "release:sbx-1"]);
  });

  it("release of an unknown run is a no-op", async () => {
    const { host } = setup();
    await expect(host.releaseProfileBrowser!({ scope: "local", runId: "nope", profile: "acct" })).resolves.toBeUndefined();
  });

  it("sweeps containers of dead runs by label and leaves live runs alone", async () => {
    const { fake, host, request } = setup();
    await host.ensureProfileBrowser(await request("live"));
    await host.ensureProfileBrowser(await request("dead"));
    const swept = await sweepOrphanBrowserSessions({
      isRunLive: async (runId) => runId === "live",
      host,
      socketRoot: path.join(root, "sock"),
    });
    expect(swept.released).toEqual(["sbx-2"]);
    expect((await fake.orchestrator.listByLabel({})).map((i) => i.labels.runId)).toEqual(["live"]);
    expect(fake.events.indexOf("close:2")).toBeLessThan(fake.events.indexOf("release:sbx-2"));
  });

  it("run teardown releases the run's container after its anchor session and clears the anchor", async () => {
    const { fake, support, request } = setup();
    const runDir = path.join(root, "run");
    const req = await request();
    await ensureRunProfileBrowser(support, { runId: "run-1", runDir, browser: req.browser, profile: req.profile });
    expect((await readPersistedAnchor(runDir, "acct"))?.scope).toBe("local");
    await teardownRunBrowsers(support, { runId: "run-1", runDir });
    expect(fake.events).toEqual(["close:1", "release:sbx-1"]);
    expect(await readPersistedAnchor(runDir, "acct")).toBeUndefined();
  });

  it("a restarted container is persisted so the stage env address can be swapped", async () => {
    const { fake, support, request } = setup();
    const runDir = path.join(root, "run");
    const req = await request();
    const input = { runId: "run-1", runDir, browser: req.browser, profile: req.profile };
    await ensureRunProfileBrowser(support, input);
    fake.crash(1);
    const again = await ensureRunProfileBrowser(support, input);
    expect(again.restarted).toBe(true);
    const stored = JSON.parse(await readFile(path.join(runDir, "browser", "acct", "anchor.json"), "utf8"));
    expect(stored).toMatchObject({ cdpAddress: fake.addressOf(2), restarts: 1 });
  });

  it("refuses the local-only profile folder helper", async () => {
    const { host, request } = setup();
    await expect(host.profileBrowserEnv(await request())).rejects.toThrow(/local host/);
  });
});

describe("volume profile store", () => {
  it("hands out volume references per scope and never a folder", async () => {
    const store = createVolumeProfileStore();
    const a = await store.open({ scope: "local", name: "acct" });
    const b = await store.open({ scope: "tenant-2", name: "acct" });
    expect(a).toEqual({ key: { scope: "local", name: "acct" }, volumeRef: "local/acct" });
    expect(b.volumeRef).toBe("tenant-2/acct");
    expect(await store.open({ scope: "local", name: "acct" })).toBe(a);
    expect(await store.list("local")).toEqual(["acct"]);
    await store.delete({ scope: "local", name: "acct" });
    expect(await store.list("local")).toEqual([]);
    await store.deleteScope("tenant-2");
    expect(await store.list("tenant-2")).toEqual([]);
    await expect(store.open({ scope: "local", name: "../x" })).rejects.toThrow();
  });
});
