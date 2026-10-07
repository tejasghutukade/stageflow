import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentBrowserLiveViewRelay } from "../src/browser/agentBrowserLiveViewRelay.js";
import type { BrowserEnv, BrowserHost, BrowserRunner } from "../src/browser/browserHost.js";
import { createContainerBrowserHost } from "../src/browser/containerBrowserHost.js";
import { createDockerSandboxOrchestrator } from "../src/browser/dockerSandboxOrchestrator.js";
import type { LiveViewMessage } from "../src/browser/liveViewRelay.js";
import { createVolumeProfileStore } from "../src/browser/volumeProfileStore.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const enabled = process.env.STAGEFLOW_DOCKER_SMOKE === "1";

function tool(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const usable = enabled && tool("docker", ["info", "--format", "{{.ServerVersion}}"]);
const hasAgentBrowser = usable && tool("agent-browser", ["--version"]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.STAGEFLOW_BROWSER_SANDBOX_IMAGE ?? "stageflow-browser-sandbox:local";
const scope = `smoke-${randomBytes(3).toString("hex")}`;
const volumes = new Set<string>();

function docker(args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

function ab(args: string[], env: BrowserEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "agent-browser",
      args,
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: 60_000 },
      (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) }),
    );
  });
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const page = (body: string) => `<!doctype html><meta charset=utf-8><body style="margin:0;font:20px system-ui">${body}`;
const PAGES: Record<string, string> = {
  "/login": page(
    `<form method=post action=/login><input id=user name=user style="position:absolute;left:40px;top:40px;width:300px;height:40px;font-size:20px"><input id=pass name=pass type=password style="position:absolute;left:40px;top:100px;width:300px;height:40px;font-size:20px"><button type=submit style="position:absolute;left:40px;top:160px;width:300px;height:44px">Continue</button></form>`,
  ),
};

function startSite(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/login") {
      req.resume();
      req.on("end", () =>
        res.writeHead(303, { Location: "/home", "Set-Cookie": "smoke_session=ok; Path=/; Max-Age=86400" }).end(),
      );
      return;
    }
    if (url.pathname === "/home") {
      const signedIn = (req.headers.cookie ?? "").includes("smoke_session=ok");
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end(page(`<h1 id=state>${signedIn ? "SIGNED_IN" : "ANONYMOUS"}</h1>`));
    }
    const html = PAGES[url.pathname];
    if (html === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "0.0.0.0", () => resolve({ server, port: (server.address() as AddressInfo).port })),
  );
}

type Input = Record<string, unknown>;
function keyEvents(ch: string): Input[] {
  const upper = ch.toUpperCase();
  const code = /[a-z]/i.test(ch) ? `Key${upper}` : /\d/.test(ch) ? `Digit${ch}` : "Unidentified";
  const base = { type: "input_keyboard", key: ch, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers: 0 };
  return [
    { ...base, eventType: "keyDown", text: ch },
    { ...base, eventType: "keyUp" },
  ];
}
const ENTER: Input[] = [
  { type: "input_keyboard", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, eventType: "keyDown", text: "\r" },
  { type: "input_keyboard", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, eventType: "keyUp" },
];

describe.skipIf(!usable)("container browser host, real Docker (STAGEFLOW_DOCKER_SMOKE=1)", () => {
  let socketRoot: string;
  let host: BrowserHost;
    let site: { server: Server; port: number };
  const profiles = createVolumeProfileStore();
  const runner: BrowserRunner = (args, env) => ab(args, env);

  beforeAll(async () => {
    const present = await docker(["image", "inspect", image]);
    if (present.code !== 0) {
      const built = await docker(["build", "-f", "docker/Dockerfile.browser-sandbox", "-t", image, "docker"], 1_200_000);
      expect(built.code, built.stderr.slice(-2000)).toBe(0);
    }
    socketRoot = await mkdtemp(path.join("/tmp", "sfcs-"));
    process.env.STAGEFLOW_HOME = path.join(socketRoot, "home");
    resetGlobalStageflowHomeForTests();
    host = createContainerBrowserHost({
      orchestrator: createDockerSandboxOrchestrator({ image, shmSize: "512m", user: "1000:1000", stopTimeoutSeconds: 5 }),
      local: { socketRoot: path.join(socketRoot, "sock") },
    });
    site = await startSite();
  }, 1_300_000);

  afterAll(async () => {
    await host?.sweepOrphans?.({ isRunLive: async () => false });
    for (const name of volumes) await docker(["volume", "rm", "-f", name]);
    await new Promise((r) => site?.server.close(r));
    resetGlobalStageflowHomeForTests();
    delete process.env.STAGEFLOW_HOME;
    if (socketRoot) await rm(socketRoot, { recursive: true, force: true });
  }, 300_000);

  async function ensure(runId: string, previous?: Awaited<ReturnType<BrowserHost["ensureProfileBrowser"]>>) {
    const profile = await profiles.open({ scope, name: "acct" });
    volumes.add(`sf-profile-${scope}-acct`);
    return host.ensureProfileBrowser({
      runId,
      browser: { profile: "acct" },
      profile,
      runner,
      ...(previous !== undefined ? { previous: { cdpAddress: previous.cdpAddress, anchorEnv: previous.anchorEnv } } : {}),
    });
  }

  async function stageEnv(runId: string, cdpAddress: string): Promise<BrowserEnv> {
    const profile = await profiles.open({ scope, name: "acct" });
    return host.stageEnv({ runId, stageId: "login", browser: { profile: "acct" }, profile, cdpAddress });
  }

  it("runs hardened, loopback-only, and survives remove-and-recreate on the same volume", async () => {
    const first = await ensure("smoke-run-1");
    expect(first.cdpAddress).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);

    const [inspect] = JSON.parse((await docker(["inspect", ...(await docker(["ps", "-q", "--filter", "label=stageflow.run=smoke-run-1"])).stdout.trim().split("\n")])).stdout) as Array<{
      Config: { User: string };
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[];
        SecurityOpt: string[];
        PidsLimit: number;
        Memory: number;
        Privileged: boolean;
        Binds: string[] | null;
        PortBindings: Record<string, Array<{ HostIp: string }>>;
      };
    }>;
    expect(inspect!.Config.User).toBe("1000:1000");
    expect(inspect!.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect!.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(inspect!.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(inspect!.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(inspect!.HostConfig.Memory).toBeGreaterThan(0);
    expect(inspect!.HostConfig.Privileged).toBe(false);
    expect(JSON.stringify(inspect!.HostConfig.Binds ?? [])).not.toContain("docker.sock");
    const bindings = Object.values(inspect!.HostConfig.PortBindings).flat();
    expect(bindings.length).toBeGreaterThan(0);
    for (const b of bindings) expect(b.HostIp).toBe("127.0.0.1");

    if (!hasAgentBrowser) {
      console.log("agent-browser not on PATH: skipped the live view login, only checked container lifecycle");
      return;
    }

    const env = await stageEnv("smoke-run-1", first.cdpAddress);
    const loginUrl = `http://host.docker.internal:${site.port}/login`;
    expect((await ab(["open", loginUrl], env)).code).toBe(0);
    const session = await createAgentBrowserLiveViewRelay({ runner }).open({
      runId: "smoke-run-1",
      stageId: "login",
      env,
      anchorEnv: first.anchorEnv,
      cdpAddress: first.cdpAddress,
    });
    const got: LiveViewMessage[] = [];
    session.subscribe((m) => got.push(m));
    try {
      await until(() => got.some((m) => m.type === "frame") || undefined, "first frame from the container browser");
      const click = (x: number, y: number) => {
        const base = { type: "input_mouse", x, y, button: "left", clickCount: 1 };
        return session.sendInput([
          { ...base, eventType: "mouseMoved" },
          { ...base, eventType: "mousePressed" },
          { ...base, eventType: "mouseReleased" },
        ]);
      };
      const type = (text: string) => session.sendInput([...text].flatMap(keyEvents));
      expect((await click(150, 60)).ok).toBe(true);
      expect((await type("alice")).ok).toBe(true);
      expect((await click(150, 120)).ok).toBe(true);
      expect((await type("secret1")).ok).toBe(true);
      expect((await session.sendInput(ENTER)).ok).toBe(true);
      await until(async () => (await ab(["eval", "document.getElementById('state') && document.getElementById('state').textContent"], env)).stdout.includes("SIGNED_IN"), "logged in page");
    } finally {
      await session.close();
    }
    await ab(["tab", "close"], env);
    await ab(["close"], env);

    await host.releaseProfileBrowser!({ scope, runId: "smoke-run-1", profile: "acct" });
    expect((await docker(["ps", "-aq", "--filter", "label=stageflow.run=smoke-run-1"])).stdout.trim()).toBe("");

    const second = await ensure("smoke-run-2");
    const env2 = await stageEnv("smoke-run-2", second.cdpAddress);
    expect((await ab(["open", `http://host.docker.internal:${site.port}/home`], env2)).code).toBe(0);
    const state = await until(async () => {
      const out = (await ab(["eval", "document.getElementById('state') && document.getElementById('state').textContent"], env2)).stdout;
      return out.includes("SIGNED_IN") || out.includes("ANONYMOUS") ? out : undefined;
    }, "home page state");
    expect(state).toContain("SIGNED_IN");
    await ab(["tab", "close"], env2);
    await ab(["close"], env2);
    await host.releaseProfileBrowser!({ scope, runId: "smoke-run-2", profile: "acct" });
  }, 600_000);

  it("replaces a killed container (stale profile lock) and reports a restarted anchor", async () => {
    const first = await ensure("smoke-run-3");
    const id = (await docker(["ps", "-q", "--filter", "label=stageflow.run=smoke-run-3"])).stdout.trim();
    expect((await docker(["kill", id])).code).toBe(0);
    const second = await ensure("smoke-run-3", first);
    expect(second.restarted).toBe(true);
    expect(second.cdpAddress).not.toBe(first.cdpAddress);
    expect((await docker(["ps", "-aq", "--filter", "label=stageflow.run=smoke-run-3"])).stdout.trim().split("\n")).toHaveLength(1);
    await host.releaseProfileBrowser!({ scope, runId: "smoke-run-3", profile: "acct" });
  }, 300_000);

  it("sweeps the containers of dead runs by label", async () => {
    await ensure("smoke-run-4");
    const swept = await host.sweepOrphans!({ isRunLive: async (runId) => runId !== "smoke-run-4" });
    expect(swept.released).toHaveLength(1);
    expect((await docker(["ps", "-aq", "--filter", "label=stageflow.run=smoke-run-4"])).stdout.trim()).toBe("");
  }, 300_000);
});
