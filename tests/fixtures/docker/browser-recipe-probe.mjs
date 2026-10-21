import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

await mkdir(process.env.STAGEFLOW_HOME, { recursive: true });
await copyFile("/config.example.yaml", path.join(process.env.STAGEFLOW_HOME, "config.yaml"));

const dist = "/opt/stageflow/dist";
const { consoleStageBrowserSupport, resolveStageBrowserEnv } = await import(`${dist}/browser/stageBrowserEnv.js`);
const { createAgentBrowserLiveViewRelay } = await import(`${dist}/browser/agentBrowserLiveViewRelay.js`);
const { readLiveViewSessionRequest } = await import(`${dist}/browser/liveViewPersisted.js`);
const { defaultBrowserRunner, teardownRunBrowsers } = await import(`${dist}/browser/browserTeardown.js`);

const PERMISSION_PROBE = `(async () => {
  const wait = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const started = Date.now();
  const notification = await Promise.race([Notification.requestPermission(), wait(2500, "pending")]);
  const geolocation = await new Promise((resolve) => {
    setTimeout(() => resolve({ code: "pending" }), 2500);
    navigator.geolocation.getCurrentPosition(() => resolve({ code: "granted" }), (e) => resolve({ code: e.code }));
  });
  const clipboard = await Promise.race([
    navigator.clipboard.readText().then(() => "resolved", (e) => "rejected:" + e.name),
    wait(2500, "pending"),
  ]);
  return JSON.stringify({ notification, geolocation: geolocation.code, clipboard, ms: Date.now() - started });
})()`;

async function browserCommandLine() {
  for (const pid of (await readdir("/proc")).filter((n) => /^\d+$/.test(n))) {
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (args.some((a) => a.startsWith("--remote-debugging")) && !args.some((a) => a.startsWith("--type="))) return args;
    } catch {}
  }
  return [];
}

const result = { env: { DISPLAY: process.env.DISPLAY ?? null } };
const server = createServer((_req, res) =>
  res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>fixture</title><h1 style='font:40px sans-serif'>Fixture login</h1><input id=u>"),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/login`;
const runDir = await mkdtemp(path.join(os.tmpdir(), "sf-probe-run-"));
const runId = "probe-run";
const stageId = "login";
const support = consoleStageBrowserSupport();
let session;
try {
  result.capabilities = { display: support.host.capabilities?.display, liveView: support.host.capabilities?.liveView };
  try {
    const env = await resolveStageBrowserEnv(support, {
      runId,
      stageId,
      scope: "local",
      runDir,
      browser: { profile: "probe", login_url: url },
      humanLogin: true,
    });
    result.resolved = { ok: true, headed: env?.AGENT_BROWSER_HEADED };
    const ev = async (js) => {
      const out = await defaultBrowserRunner(["eval", js], env, { timeoutMs: 30000 });
      try {
        return JSON.parse(out.stdout ?? "");
      } catch {
        return String(out.stdout ?? "").trim();
      }
    };
    const deadline = Date.now() + 30000;
    let href = await ev("location.href");
    while (!String(href).startsWith(url) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      href = await ev("location.href");
    }
    result.page = { href, title: await ev("document.title") };
    result.userAgent = await ev("navigator.userAgent");
    result.commandLine = (await browserCommandLine()).filter((a) => a.startsWith("--deny-permission-prompts") || a.startsWith("--no-sandbox"));
    result.permissions = JSON.parse(await ev(PERMISSION_PROBE));
    const { AGENT_BROWSER_PROFILE, AGENT_BROWSER_CDP, AGENT_BROWSER_PIN_TAB, ...rest } = env;
    const controlEnv = { ...rest, AGENT_BROWSER_SESSION: "sf-probe-control", AGENT_BROWSER_ARGS: "--no-sandbox", AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium" };
    try {
      await defaultBrowserRunner(["open", url], controlEnv, { timeoutMs: 60000 });
      const out = await defaultBrowserRunner(["eval", PERMISSION_PROBE], controlEnv, { timeoutMs: 30000 });
      result.controlPermissions = JSON.parse(JSON.parse(out.stdout ?? "null"));
    } catch (err) {
      result.controlPermissions = { error: String(err?.message ?? err) };
    } finally {
      await defaultBrowserRunner(["close"], controlEnv, { timeoutMs: 30000 }).catch(() => undefined);
    }
    const request = await readLiveViewSessionRequest({ runDir, runId, stageId, profile: "probe" });
    session = await createAgentBrowserLiveViewRelay({ runner: defaultBrowserRunner }).open(request);
    result.frame = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 45000);
      session.subscribe((m) => {
        if (m.type === "frame") {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  } catch (err) {
    result.error = String(err?.message ?? err);
  }
} finally {
  await session?.close().catch(() => undefined);
  await teardownRunBrowsers(support, { runId, runDir }).catch(() => undefined);
  server.close();
}
process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`);
process.exit(0);
