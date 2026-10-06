import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRunProfileBrowser, readPersistedAnchor } from "../src/browser/anchor.js";
import type { BrowserRunner, StageBrowserSupport } from "../src/browser/browserHost.js";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createInMemoryProfileStore } from "../src/browser/memoryProfileStore.js";
import { LOCAL_BROWSER_SCOPE } from "../src/browser/profileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-anchor-"));
  process.env.STAGEFLOW_HOME = path.join(root, "home");
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const calls: string[][] = [];
  let cdp = "ws://127.0.0.1:41000/devtools/browser/one";
  const runner: BrowserRunner = async (args) => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 10));
    return { code: 0, stdout: args[0] === "get" ? `${cdp}\n` : "" };
  };
  const profiles = createInMemoryProfileStore();
  const support: StageBrowserSupport = {
    host: createLocalBrowserHost({ platform: "darwin", hostEnv: {}, socketRoot: path.join(root, "sock") }),
    profiles,
    runner,
  };
  const input = async () => ({
    runId: "run-1",
    runDir: path.join(root, "run"),
    browser: { profile: "acct" },
    profile: await profiles.open({ scope: LOCAL_BROWSER_SCOPE, name: "acct" }),
  });
  return { calls, support, input, setCdp: (v: string) => (cdp = v) };
}

describe("ensureRunProfileBrowser", () => {
  it("starts one anchor for concurrent callers and persists it", async () => {
    const { calls, support, input } = setup();
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => ensureRunProfileBrowser(support, await input())),
    );
    expect(new Set(results.map((r) => r.cdpAddress)).size).toBe(1);
    expect(calls.filter((c) => c[0] === "open")).toHaveLength(1);
    expect(calls.filter((c) => c.join(" ") === "get cdp-url").length).toBeGreaterThanOrEqual(1);
    const stored = await readPersistedAnchor(path.join(root, "run"), "acct");
    expect(stored?.cdpAddress).toBe(results[0]!.cdpAddress);
  });

  it("reuses the persisted anchor in a later call without opening again", async () => {
    const { calls, support, input } = setup();
    await ensureRunProfileBrowser(support, await input());
    const again = await ensureRunProfileBrowser(support, await input());
    expect(again.restarted).toBe(false);
    expect(calls.filter((c) => c[0] === "open")).toHaveLength(1);
  });

  it("refreshes the persisted address when the anchor came back on a new one", async () => {
    const { support, input, setCdp } = setup();
    await ensureRunProfileBrowser(support, await input());
    setCdp("ws://127.0.0.1:42000/devtools/browser/two");
    const again = await ensureRunProfileBrowser(support, await input());
    expect(again.restarted).toBe(true);
    const file = await readFile(path.join(root, "run", "browser", "acct", "anchor.json"), "utf8");
    expect(JSON.parse(file)).toMatchObject({
      cdpAddress: "ws://127.0.0.1:42000/devtools/browser/two",
      restarts: 1,
    });
  });

  it("fails clearly when agent-browser gives no address", async () => {
    const { support, input } = setup();
    support.runner = async () => ({ code: 0, stdout: "" });
    await expect(ensureRunProfileBrowser(support, await input())).rejects.toThrow(/shared browser address/);
  });
});
