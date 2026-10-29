import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRunProfileBrowser, readPersistedAnchor } from "../src/browser/anchor.js";
import type { BrowserHost, ProfileBrowserRequest, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-anchor-via-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});
afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

describe("anchor persists which browser of a routing host started it", () => {
  it("stores `via`, hands it back as `previous.via`, and records a change of browser", async () => {
    const seen: Array<ProfileBrowserRequest["previous"]> = [];
    let via: "login" | "work" = "login";
    const host: BrowserHost = {
      async ensureProfileBrowser(request) {
        seen.push(request.previous);
        return { cdpAddress: `ws://${via}`, anchorEnv: { AGENT_BROWSER_SESSION: via }, via, restarted: false };
      },
      async stageEnv() {
        return {};
      },
      async profileBrowserEnv() {
        return {};
      },
    };
    const profiles = createVolumeProfileStore();
    const support: StageBrowserSupport = { host, profiles };
    const profile = await profiles.open({ scope: "local", name: "acct" });
    const input = { runId: "run-1", runDir: path.join(root, "run"), browser: { profile: "acct" }, profile };

    await ensureRunProfileBrowser(support, input);
    expect((await readPersistedAnchor(input.runDir, "acct"))?.via).toBe("login");

    via = "work";
    const next = await ensureRunProfileBrowser(support, input);
    expect(seen[1]).toMatchObject({ cdpAddress: "ws://login", via: "login" });
    expect(next.restarted).toBe(true);
    expect((await readPersistedAnchor(input.runDir, "acct"))).toMatchObject({ via: "work", cdpAddress: "ws://work", restarts: 1 });
  });
});

describe("a work stage on the operator's own browser is recorded as such", () => {
  it("persists an own-browser handoff when its anchor came from the login browser", async () => {
    const { resolveStageBrowserEnv } = await import("../src/browser/stageBrowserEnv.js");
    const { readStageHandoff, gateHandoffFor } = await import("../src/browser/stageHandoff.js");
    const host = (via: "login" | "work"): BrowserHost => ({
      capabilities: { display: "headless_only", liveView: "none" },
      async ensureProfileBrowser() {
        return { cdpAddress: `ws://${via}`, anchorEnv: { AGENT_BROWSER_SESSION: via }, via, restarted: false };
      },
      async stageEnv() {
        return { AGENT_BROWSER_SESSION: "stage", AGENT_BROWSER_CDP: `ws://${via}` };
      },
      async profileBrowserEnv() {
        return {};
      },
    });
    for (const via of ["login", "work"] as const) {
      const profiles = createVolumeProfileStore();
      const support: StageBrowserSupport = { host: host(via), profiles, runner: async () => ({ code: 0 }), blockedSites: [] };
      const runDir = path.join(root, `run-${via}`);
      await resolveStageBrowserEnv(support, { runId: "r1", stageId: "jobs", scope: "local", runDir, browser: { profile: "acct" } });
      const recorded = await readStageHandoff({ runDir, stageId: "jobs" });
      if (via === "login") {
        expect(recorded).toEqual({ display: "local_window", liveView: "none", ownBrowser: true });
        expect(gateHandoffFor({ runId: "r1", stageId: "jobs", capabilities: recorded! })).toEqual({ kind: "local_window", window: "own_browser" });
      } else {
        expect(recorded).toEqual({ display: "headless_only", liveView: "none" });
      }
    }
  });
});
