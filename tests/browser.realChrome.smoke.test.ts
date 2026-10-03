import { execFile, execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import {
  defaultBrowserRunner,
  teardownRunBrowsers,
  teardownStageBrowser,
} from "../src/browser/browserTeardown.js";
import { resolveStageBrowserEnv } from "../src/browser/stageBrowserEnv.js";
import { ensureRunProfileBrowser } from "../src/browser/anchor.js";
import type { BrowserEnv, StageBrowserSupport } from "../src/browser/browserHost.js";
import { LOCAL_BROWSER_SCOPE } from "../src/browser/profileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createFixtureServer } from "../examples/browser-session/fixture-server.mjs";

const enabled = process.env.STAGEFLOW_BROWSER_SMOKE === "1";

function ab(args: string[], env: BrowserEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "agent-browser",
      args,
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: 60_000 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`${stderr || err.message}`)) : resolve(String(stdout)),
    );
  });
}

function chromeProcessesFor(profileDir: string): string[] {
  try {
    return execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(profileDir));
  } catch {
    return [];
  }
}

async function tabUrls(env: BrowserEnv): Promise<string[]> {
  const out = await ab(["tab", "list", "--json"], env);
  const parsed = JSON.parse(out) as { data?: { tabs?: { url?: string }[] } };
  return (parsed.data?.tabs ?? []).map((t) => t.url ?? "");
}

describe.skipIf(!enabled)("real Chrome smoke (STAGEFLOW_BROWSER_SMOKE=1)", () => {
  let root: string;
  let saved: string | undefined;
  let server: ReturnType<typeof createFixtureServer>;
  let origin: string;
  let support: StageBrowserSupport;
  let runDir: string;
  const run = { runId: "smoke-run", runDir: "" };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sf-smoke-"));
    saved = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = path.join(root, "home");
    resetGlobalStageflowHomeForTests();
    server = createFixtureServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    runDir = path.join(root, "run");
    run.runDir = runDir;
    support = {
      host: createLocalBrowserHost({ socketRoot: path.join(root, "sock") }),
      profiles: createLocalProfileStore(),
      runner: defaultBrowserRunner,
      blockedSites: [],
    };
  });

  afterEach(async () => {
    await teardownRunBrowsers(support, run).catch(() => undefined);
    await new Promise((r) => server.close(r));
    if (saved === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = saved;
    resetGlobalStageflowHomeForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function stageEnv(stageId: string): Promise<BrowserEnv> {
    const env = await resolveStageBrowserEnv(support, {
      runId: run.runId,
      stageId,
      runDir,
      browser: { profile: "smoke", headed: false },
    });
    if (env === undefined) throw new Error("no env");
    return env;
  }

  it("shares one Chrome across parallel stage tabs and tears down per stage and per run", async () => {
    const handle = await support.profiles.open({ scope: LOCAL_BROWSER_SCOPE, name: "smoke" });

    const env1 = await stageEnv("stage-1");
    expect(env1.AGENT_BROWSER_CDP).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    expect(env1.AGENT_BROWSER_PROFILE).toBeUndefined();
    await ab(["open", `${origin}/login?go=1`], env1);
    expect(await ab(["get", "url"], env1)).toContain("/home");

    const env2 = await stageEnv("stage-2");
    expect(env2.AGENT_BROWSER_CDP).toBe(env1.AGENT_BROWSER_CDP);
    expect(env2.AGENT_BROWSER_SESSION).not.toBe(env1.AGENT_BROWSER_SESSION);

    await Promise.all([
      ab(["open", `${origin}/a`], env1),
      ab(["open", `${origin}/b`], env2),
    ]);
    for (let i = 0; i < 3; i++) {
      expect(await ab(["get", "url"], env1)).toContain("/a");
      expect(await ab(["get", "url"], env2)).toContain("/b");
    }
    for (const env of [env1, env2]) {
      const cookies = await ab(["cookies", "get"], env);
      expect(cookies).toContain("fixture_login");
      expect(cookies).toContain("fixture_session");
    }

    const before = await tabUrls(env2);
    expect(before.some((u) => u.includes("/a"))).toBe(true);
    expect(before.some((u) => u.includes("/b"))).toBe(true);

    await teardownStageBrowser(support, { ...run, stageId: "stage-1" });
    expect(chromeProcessesFor(handle.profileDir).length).toBeGreaterThan(0);
    expect(await ab(["get", "url"], env2)).toContain("/b");
    await ab(["open", `${origin}/b`], env2);
    const urls = await tabUrls(env2);
    expect(urls.some((u) => u.includes("/a"))).toBe(false);
    expect(urls.some((u) => u.includes("/b"))).toBe(true);

    await teardownRunBrowsers(support, run);
    expect(chromeProcessesFor(handle.profileDir)).toEqual([]);
    const socketRoot = path.join(root, "sock");
    const leftovers: string[] = [];
    if (existsSync(socketRoot)) {
      for (const dir of await readdir(socketRoot)) {
        for (const f of await readdir(path.join(socketRoot, dir))) leftovers.push(f);
      }
    }
    expect(leftovers).toEqual([]);

    const again = await ensureRunProfileBrowser(support, {
      runId: "smoke-run-2",
      runDir: path.join(root, "run2"),
      browser: { profile: "smoke", headed: false },
      profile: handle,
    });
    try {
      await ab(["open", `${origin}/home`], again.anchorEnv);
      expect(await ab(["get", "url"], again.anchorEnv)).toContain("/home");
      const cookies = await ab(["cookies", "get"], again.anchorEnv);
      expect(cookies).toContain("fixture_login");
      console.log(`[smoke] session-only cookie survives full close+reopen: ${cookies.includes("fixture_session")}`);
    } finally {
      await teardownRunBrowsers(support, { runId: "smoke-run-2", runDir: path.join(root, "run2") });
    }
  }, 240_000);
});
