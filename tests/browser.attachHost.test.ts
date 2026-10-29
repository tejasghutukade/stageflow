import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachBrowserHost } from "../src/browser/attachBrowserHost.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import type { BrowserEndpointClient } from "../src/browser/containerBrowserEndpoint.js";
import { resolveBrowserHostCapabilities } from "../src/browser/hostCapabilities.js";
import { resolveStageHandoffCapabilities } from "../src/browser/stageHandoff.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join("/tmp", "sfat-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(options: { reachable?: boolean; cdpUrl?: string; liveView?: "relay" | "none" } = {}) {
  const probed: string[] = [];
  const closed: string[] = [];
  const resolved: string[] = [];
  const endpoint: BrowserEndpointClient = {
    async resolve(address) {
      probed.push(address);
      if (options.reachable === false) return undefined;
      return `${address.replace(/^http/, "ws")}/devtools/browser/abc`;
    },
    async closeBrowser(address) {
      closed.push(address);
    },
  };
  const host = createAttachBrowserHost({
    cdpUrl: options.cdpUrl ?? "http://127.0.0.1:9222",
    ...(options.liveView !== undefined ? { liveView: options.liveView } : {}),
    endpoint,
    resolveHost: async (name) => {
      resolved.push(name);
      return "192.168.65.254";
    },
    local: { platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") },
  });
  const profiles = createVolumeProfileStore();
  const request = async (runId = "run-1") => ({
    runId,
    browser: { profile: "acct" },
    profile: await profiles.open({ scope: "local", name: "acct" }),
    runner: (async () => {
      throw new Error("attach must not launch or drive a browser");
    }) as BrowserRunner,
  });
  return { host, probed, closed, resolved, request };
}

describe("attach browser host", () => {
  it("returns the address of the Chrome that answers, without launching anything", async () => {
    const { host, probed, request } = setup();
    const shared = await host.ensureProfileBrowser(await request());
    expect(probed).toEqual(["http://127.0.0.1:9222"]);
    expect(shared.cdpAddress).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(shared.restarted).toBe(false);
    expect(shared.anchorEnv.AGENT_BROWSER_CDP).toBe(shared.cdpAddress);
    expect(shared.anchorEnv).not.toHaveProperty("AGENT_BROWSER_PROFILE");
    expect(shared.anchorEnv).not.toHaveProperty("AGENT_BROWSER_PIN_TAB");
  });

  it("addresses Chrome by IPv4 when the configured host is a name", async () => {
    const { host, probed, resolved, request } = setup({ cdpUrl: "http://host.docker.internal:9222" });
    const shared = await host.ensureProfileBrowser(await request());
    expect(resolved).toEqual(["host.docker.internal"]);
    expect(probed).toEqual(["http://192.168.65.254:9222"]);
    expect(shared.cdpAddress).toContain("192.168.65.254:9222");
  });

  it("maps localhost to 127.0.0.1 and keeps secure schemes", async () => {
    const local = setup({ cdpUrl: "http://localhost:9222" });
    await local.host.ensureProfileBrowser(await local.request());
    expect(local.probed).toEqual(["http://127.0.0.1:9222"]);
    expect(local.resolved).toEqual([]);
    const secure = setup({ cdpUrl: "wss://10.0.0.5:9443" });
    await secure.host.ensureProfileBrowser(await secure.request());
    expect(secure.probed).toEqual(["https://10.0.0.5:9443"]);
  });

  it("says how to start Chrome when nothing answers", async () => {
    const { host, request } = setup({ reachable: false });
    await expect(host.ensureProfileBrowser(await request())).rejects.toThrow(/remote-debugging-port/);
  });

  it("flags a changed address as a restart", async () => {
    const { host, request } = setup();
    const first = await host.ensureProfileBrowser(await request());
    const next = await host.ensureProfileBrowser({
      ...(await request()),
      previous: { cdpAddress: "ws://127.0.0.1:1111/x", anchorEnv: first.anchorEnv },
    });
    expect(next.restarted).toBe(true);
  });

  it("never closes or sweeps the user's Chrome", async () => {
    const { host, closed, request } = setup();
    await host.ensureProfileBrowser(await request());
    expect(host.releaseProfileBrowser).toBeUndefined();
    expect(host.sweepOrphans).toBeUndefined();
    expect(closed).toEqual([]);
  });

  it("has no profile folder for `sf browser login`", async () => {
    const { host } = setup();
    await expect(host.profileBrowserEnv({ runId: "r", browser: {}, profile: await createVolumeProfileStore().open({ scope: "local", name: "a" }) })).rejects.toThrow(/local host/);
  });

  it("offers a real window to a human login, even with no screen on the Host", () => {
    const { host } = setup();
    expect(resolveBrowserHostCapabilities(host.capabilities)).toMatchObject({ display: "local_window", attach: "cdp", liveView: "none" });
    const support = { host, profiles: createVolumeProfileStore() } as StageBrowserSupport;
    expect(resolveStageHandoffCapabilities(support, { humanLogin: true })).toEqual({ display: "local_window", liveView: "none" });
  });

  it("reports the live view relay when the process serves the console", () => {
    expect(resolveBrowserHostCapabilities(setup({ liveView: "relay" }).host.capabilities).liveView).toBe("relay");
  });
});
