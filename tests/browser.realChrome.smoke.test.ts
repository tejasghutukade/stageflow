import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBrowserHost } from "../src/browser/localBrowserHost.js";
import { createLocalProfileStore } from "../src/browser/localProfileStore.js";
import { closeBrowserSession } from "../src/browser/browserTeardown.js";
import { LOCAL_BROWSER_SCOPE } from "../src/browser/profileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createFixtureServer } from "../examples/browser-session/fixture-server.mjs";

const enabled = process.env.STAGEFLOW_BROWSER_SMOKE === "1";

function ab(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "agent-browser",
      args,
      { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${stderr || err.message}`)) : resolve(String(stdout))),
    );
  });
}

describe.skipIf(!enabled)("real Chrome smoke (STAGEFLOW_BROWSER_SMOKE=1)", () => {
  let root: string;
  let saved: string | undefined;
  let server: ReturnType<typeof createFixtureServer>;
  let origin: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sf-smoke-"));
    saved = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = path.join(root, "home");
    resetGlobalStageflowHomeForTests();
    server = createFixtureServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    if (saved === undefined) delete process.env.STAGEFLOW_HOME;
    else process.env.STAGEFLOW_HOME = saved;
    resetGlobalStageflowHomeForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the login across a Host close and a new stage with a new HOME", async () => {
    const profiles = createLocalProfileStore();
    const handle = await profiles.open({ scope: LOCAL_BROWSER_SCOPE, name: "smoke" });
    const env = await createLocalBrowserHost().profileBrowserEnv({
      runId: "smoke-run",
      browser: { profile: "smoke", headed: false },
      profile: handle,
    });
    const stageEnv = async (n: number) => ({ ...env, HOME: path.join(root, `attempt-home-${n}`) });

    try {
      await ab(["open", `${origin}/login?go=1`], await stageEnv(1));
      expect(await ab(["get", "url"], await stageEnv(1))).toContain("/home");

      const closed = await closeBrowserSession(env);
      expect(closed.gone).toBe(true);

      await ab(["open", `${origin}/home`], await stageEnv(2));
      expect(await ab(["get", "url"], await stageEnv(2))).toContain("/home");
      const cookies = await ab(["cookies", "get"], await stageEnv(2));
      expect(cookies).toContain("fixture_login");
      // Chrome drops session-only cookies when the browser closes; only persistent cookies survive a Host close.
      expect(cookies).not.toContain("fixture_session");
    } finally {
      await closeBrowserSession(env).catch(() => undefined);
    }
  }, 120_000);
});
