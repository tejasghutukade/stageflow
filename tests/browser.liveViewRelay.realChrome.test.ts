import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserEnv, BrowserRunner } from "../src/browser/browserHost.js";
import { createAgentBrowserLiveViewRelay } from "../src/browser/agentBrowserLiveViewRelay.js";
import type { LiveViewMessage } from "../src/browser/liveViewRelay.js";

const enabled = process.env.STAGEFLOW_BROWSER_SMOKE === "1";

const page = (body: string) => `<!doctype html><meta charset=utf-8><body style="margin:0;font:20px system-ui">${body}`;
const pages: Record<string, string> = {
  "/opener": page(
    `<button id=b style="position:absolute;left:40px;top:40px;width:240px;height:60px" onclick="window.open('/popup','p','width=500,height=400')">Sign in</button><p id=out style="position:absolute;top:140px">waiting</p><script>addEventListener('message',e=>{out.textContent='token:'+e.data.token})</script>`,
  ),
  "/dialogs": page(
    `<button id=c style="position:absolute;left:40px;top:40px;width:240px;height:50px" onclick="out.textContent='confirm='+confirm('Proceed?')">Confirm</button>` +
      `<button id=p style="position:absolute;left:40px;top:110px;width:240px;height:50px" onclick="out.textContent='prompt='+prompt('Name?','Ada')">Prompt</button>` +
      `<button id=a style="position:absolute;left:40px;top:180px;width:240px;height:50px" onclick="alert('Heads up');out.textContent='alert-done'">Alert</button>` +
      `<button id=w style="position:absolute;left:40px;top:250px;width:240px;height:50px" onclick="window.open('/dialog-popup','p','width=500,height=400')">Popup</button>` +
      `<a id=nav href="/dialogs-next" style="position:absolute;left:40px;top:320px;display:block;width:240px;height:50px">Leave</a>` +
      `<p id=out style="position:absolute;top:390px">waiting</p>` +
      `<script>onbeforeunload=e=>{e.preventDefault();e.returnValue='stay'};addEventListener('message',e=>{out.textContent=e.data})</script>`,
  ),
  "/dialogs-next": page(`<p id=out>next</p>`),
  "/dialog-popup": page(
    `<p>popup</p><script>setTimeout(()=>{const r=confirm('Popup question?');opener.postMessage('popup-confirm='+r,'*');window.close()},300)</script>`,
  ),
  "/popup": page(
    `<button id=a style="position:absolute;left:40px;top:40px;width:240px;height:60px" onclick="opener.postMessage({token:'T123'},'*');window.close()">Authorize</button>`,
  ),
};

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

async function evalJson<T>(env: BrowserEnv, js: string): Promise<T | undefined> {
  const out = (await ab(["eval", js], env)).stdout.trim();
  try {
    let value: unknown = JSON.parse(out);
    if (typeof value === "string") value = JSON.parse(value);
    return value as T;
  } catch {
    return undefined;
  }
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!enabled)("live view relay real Chrome popup (STAGEFLOW_BROWSER_SMOKE=1)", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  let env: BrowserEnv | undefined;

  afterEach(async () => {
    if (env !== undefined) await ab(["close"], env);
    if (server !== undefined) await new Promise((r) => server!.close(r));
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    env = server = dir = undefined;
  });

  it("follows a window.open popup and back, and the opener receives the token", async () => {
    dir = await mkdtemp(path.join("/tmp", "sfrt-"));
    server = createServer((req, res) => {
      const html = pages[new URL(req.url ?? "/", "http://x").pathname];
      if (html === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sessionEnv: BrowserEnv = {
      AGENT_BROWSER_SOCKET_DIR: dir,
      AGENT_BROWSER_SESSION: "sfrt-popup",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AGENT_BROWSER_HEADED: "0",
    };
    env = sessionEnv;
    expect((await ab(["open", `${origin}/opener`], sessionEnv)).code).toBe(0);

    const runner: BrowserRunner = (args, e) => ab(args, e);
    const session = await createAgentBrowserLiveViewRelay({ runner }).open({
      runId: "r",
      stageId: "s",
      env: sessionEnv,
    });
    const got: LiveViewMessage[] = [];
    session.subscribe((m) => got.push(m));
    const retargets = () => got.filter((m) => m.type === "retarget").map((m) => m.data as { reason: string });

    const center = (id: string) =>
      until(async () => {
        const r = await evalJson<{ x: number; y: number } | null>(
          sessionEnv,
          `(() => { const e = document.getElementById('${id}'); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}); })()`,
        );
        return r ?? undefined;
      }, `button ${id}`);
    const clickAt = async ({ x, y }: { x: number; y: number }) => {
      const base = { type: "input_mouse", x, y, button: "left", clickCount: 1 };
      const result = await session.sendInput([
        { ...base, eventType: "mouseMoved" },
        { ...base, eventType: "mousePressed" },
        { ...base, eventType: "mouseReleased" },
      ]);
      expect(result.ok).toBe(true);
    };

    try {
      await until(() => got.some((m) => m.type === "frame") || undefined, "first frame");
      await clickAt(await center("b"));
      await until(() => retargets().length >= 1 || undefined, "popup retarget");
      expect(retargets()[0]!.reason).toBe("popup_opened");

      await clickAt(await center("a"));
      await until(() => retargets().length >= 2 || undefined, "retarget back");
      expect(retargets()[1]!.reason).toBe("tab_closed");

      const text = await until(async () => {
        const out = (await ab(["eval", "document.getElementById('out').textContent"], sessionEnv)).stdout;
        return out.includes("token:T123") ? out : undefined;
      }, "token in opener");
      expect(text).toContain("token:T123");
    } finally {
      await session.close();
    }
  }, 240_000);
});

describe.skipIf(!enabled)("live view relay real Chrome dialogs (STAGEFLOW_BROWSER_SMOKE=1)", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  let env: BrowserEnv | undefined;

  afterEach(async () => {
    if (env !== undefined) await ab(["close"], env);
    if (server !== undefined) await new Promise((r) => server!.close(r));
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    env = server = dir = undefined;
  });

  it("reports and answers confirm and prompt, reports alert and beforeunload read-only, and sees a popup dialog", async () => {
    dir = await mkdtemp(path.join("/tmp", "sfrd-"));
    server = createServer((req, res) => {
      const html = pages[new URL(req.url ?? "/", "http://x").pathname];
      if (html === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(html);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sessionEnv: BrowserEnv = {
      AGENT_BROWSER_SOCKET_DIR: dir,
      AGENT_BROWSER_SESSION: "sfrd-dialog",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
      AGENT_BROWSER_HEADED: "0",
    };
    env = sessionEnv;
    expect((await ab(["open", `${origin}/dialogs`], sessionEnv)).code).toBe(0);

    const runner: BrowserRunner = (args, e) => ab(args, e);
    const session = await createAgentBrowserLiveViewRelay({ runner }).open({ runId: "r", stageId: "s", env: sessionEnv });
    const got: LiveViewMessage[] = [];
    session.subscribe((m) => got.push(m));
    const dialogs = () => got.filter((m) => m.type === "dialog").map((m) => m.data as Record<string, any>);
    const closings = () => got.filter((m) => m.type === "dialog_closed").map((m) => m.data as Record<string, any>);
    const out = async () => (await ab(["eval", "document.getElementById('out').textContent"], sessionEnv)).stdout;

    const center = (id: string) =>
      until(async () => {
        const r = await evalJson<{ x: number; y: number } | null>(
          sessionEnv,
          `(() => { const e = document.getElementById('${id}'); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}); })()`,
        );
        return r ?? undefined;
      }, `button ${id}`);
    const clickAt = async ({ x, y }: { x: number; y: number }) => {
      const base = { type: "input_mouse", x, y, button: "left", clickCount: 1 };
      const result = await session.sendInput([
        { ...base, eventType: "mouseMoved" },
        { ...base, eventType: "mousePressed" },
        { ...base, eventType: "mouseReleased" },
      ]);
      expect(result.ok).toBe(true);
    };
    const nextDialog = async (n: number) => {
      await until(() => dialogs().length >= n || undefined, `dialog ${n}`);
      return dialogs()[n - 1]!;
    };
    const answered = async (n: number, answer: { accept: boolean; promptText?: string }) => {
      const dialog = await nextDialog(n);
      expect(await session.answerDialog({ id: dialog.id, ...answer })).toEqual({ ok: true });
      await until(() => closings().length >= n || undefined, `closed ${n}`);
      return closings()[n - 1]!;
    };

    try {
      await until(() => got.some((m) => m.type === "frame") || undefined, "first frame");

      await clickAt(await center("c"));
      expect(await nextDialog(1)).toMatchObject({ kind: "confirm", message: "Proceed?", answerable: true });
      expect((await answered(1, { accept: true })).result).toBe("accepted");
      await until(async () => ((await out()).includes("confirm=true") ? true : undefined), "confirm result");

      await clickAt(await center("p"));
      expect(await nextDialog(2)).toMatchObject({ kind: "prompt", message: "Name?", defaultPrompt: "Ada", answerable: true });
      expect((await answered(2, { accept: true })).result).toBe("accepted");
      await until(async () => ((await out()).includes("prompt=Ada") ? true : undefined), "prompt default result");

      await clickAt(await center("p"));
      await nextDialog(3);
      await answered(3, { accept: true, promptText: "Grace" });
      await until(async () => ((await out()).includes("prompt=Grace") ? true : undefined), "prompt text result");

      await clickAt(await center("c"));
      await nextDialog(4);
      expect((await answered(4, { accept: false })).result).toBe("dismissed");
      await until(async () => ((await out()).includes("confirm=false") ? true : undefined), "confirm dismissed result");

      await clickAt(await center("a"));
      expect(await nextDialog(5)).toMatchObject({ kind: "alert", message: "Heads up", answerable: false });
      await until(() => closings().length >= 5 || undefined, "alert auto-handled");
      expect(await session.answerDialog({ id: dialogs()[4]!.id, accept: true })).toMatchObject({ ok: false });
      await until(async () => ((await out()).includes("alert-done") ? true : undefined), "alert result");

      await clickAt(await center("w"));
      const popupDialog = await nextDialog(6);
      expect(popupDialog).toMatchObject({ kind: "confirm", message: "Popup question?", answerable: true });
      expect(got.some((m) => m.type === "retarget")).toBe(true);
      expect((await answered(6, { accept: true })).result).toBe("accepted");
      await until(async () => ((await out()).includes("popup-confirm=true") ? true : undefined), "popup result");

      await clickAt(await center("nav"));
      expect(await nextDialog(7)).toMatchObject({ kind: "beforeunload", answerable: false });
      await until(() => closings().length >= 7 || undefined, "beforeunload auto-handled");
    } finally {
      await session.close();
    }
  }, 300_000);
});
