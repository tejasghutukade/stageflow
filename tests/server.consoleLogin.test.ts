import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConsoleLogin } from "../src/server/consoleLogin.js";
import {
  mintConsoleLoginCode,
  redeemConsoleLoginCode,
  resetConsoleLoginCodesForTests,
} from "../src/server/consoleLoginCode.js";
import { resetConsoleLoginAttemptsForTests } from "../src/server/consoleLogin.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startMcpServer } from "../src/server/mcpHost.js";

afterEach(() => {
  resetConsoleLoginCodesForTests();
  resetConsoleLoginAttemptsForTests();
  vi.useRealTimers();
});

function response(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => (payload.length > 0 ? JSON.parse(payload) : undefined),
  };
}

function request(remoteAddress: string, body: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    socket: { remoteAddress },
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

describe("console login codes", () => {
  it("works once, expires after 60s, and keeps only 5", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
    const code = mintConsoleLoginCode();
    expect(redeemConsoleLoginCode(code)).toBe(true);
    expect(redeemConsoleLoginCode(code)).toBe(false);

    const again = mintConsoleLoginCode();
    vi.advanceTimersByTime(60_001);
    expect(redeemConsoleLoginCode(again)).toBe(false);

    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
    const kept = Array.from({ length: 6 }, () => mintConsoleLoginCode());
    expect(redeemConsoleLoginCode(kept[0]!)).toBe(false);
    expect(redeemConsoleLoginCode(kept[5]!)).toBe(true);
  });
});

describe("POST /api/console-login", () => {
  it("rejects a non-loopback caller, a bad code, and a reused code", async () => {
    const token = "d".repeat(32);
    const denied = response();
    await handleConsoleLogin(request("10.1.2.3", { code: "nope" }), denied.res, () => token);
    expect(denied.status()).toBe(403);

    const code = mintConsoleLoginCode();
    const bad = response();
    await handleConsoleLogin(request("127.0.0.1", { code: "nope" }), bad.res, () => token);
    expect(bad.status()).toBe(401);

    const ok = response();
    await handleConsoleLogin(request("127.0.0.1", { code }), ok.res, () => token);
    expect(ok.status()).toBe(200);
    expect(ok.body()).toEqual({ token });

    const reused = response();
    await handleConsoleLogin(request("127.0.0.1", { code }), reused.res, () => token);
    expect(reused.status()).toBe(401);
  });
});

describe("console login limits", () => {
  it("lets a valid code through after many failed attempts", async () => {
    const token = "d".repeat(32);
    for (let i = 0; i < 12; i++) {
      await handleConsoleLogin(request("127.0.0.1", { code: `bad-${i}` }), response().res, () => token);
    }
    const limited = response();
    await handleConsoleLogin(request("127.0.0.1", { code: "bad-again" }), limited.res, () => token);
    expect(limited.status()).toBe(429);

    const code = mintConsoleLoginCode();
    const ok = response();
    await handleConsoleLogin(request("127.0.0.1", { code }), ok.res, () => token);
    expect(ok.status()).toBe(200);
  });

  it("refuses a body over 4 KB with 413", async () => {
    const big = response();
    await handleConsoleLogin(
      request("127.0.0.1", { code: "x".repeat(1024 * 1024) }),
      big.res,
      () => "d".repeat(32),
    );
    expect(big.status()).toBe(413);
  });
});

describe("console login over HTTP", () => {
  it("mints only for the main token, and redeems only same-origin", async () => {
    const main = "m".repeat(40);
    const named = "n".repeat(40);
    const saved = {
      main: process.env.STAGEFLOW_CONTROL_TOKEN,
      file: process.env.STAGEFLOW_CONTROL_TOKEN_FILE,
      named: process.env.STAGEFLOW_CONTROL_TOKEN_CI,
    };
    process.env.STAGEFLOW_CONTROL_TOKEN = main;
    delete process.env.STAGEFLOW_CONTROL_TOKEN_FILE;
    process.env.STAGEFLOW_CONTROL_TOKEN_CI = named;
    const root = await mkdtemp(path.join(tmpdir(), "sf-console-login-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: loadControlTokens(process.env),
    });
    try {
      const mintAs = (bearer: string) =>
        fetch(`${started.url}/api/console-login/mint`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}` },
        });
      expect((await mintAs(named)).status).toBe(403);
      const minted = await mintAs(main);
      expect(minted.status).toBe(200);
      const { code } = (await minted.json()) as { code: string };

      const crossOrigin = await fetch(`${started.url}/api/console-login`, {
        method: "POST",
        headers: { Origin: "http://evil.example", "content-type": "text/plain" },
        body: JSON.stringify({ code }),
      });
      expect(crossOrigin.status).toBe(403);

      const redeemed = await fetch(`${started.url}/api/console-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(redeemed.status).toBe(200);
      expect(await redeemed.json()).toEqual({ token: main });
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
      for (const [key, value] of [
        ["STAGEFLOW_CONTROL_TOKEN", saved.main],
        ["STAGEFLOW_CONTROL_TOKEN_FILE", saved.file],
        ["STAGEFLOW_CONTROL_TOKEN_CI", saved.named],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses to mint when no control token is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-console-login-open-"));
    const store = createRunStore({ rootDir: root });
    const started = await startMcpServer({
      agent: scriptedFakeAgent([]),
      cwd: root,
      rootDir: root,
      store,
      port: 0,
      mcpStateless: true,
      controlTokens: loadControlTokens({}),
    });
    try {
      const res = await fetch(`${started.url}/api/console-login/mint`, { method: "POST" });
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    }
  });
});
