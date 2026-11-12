import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConsoleLogin } from "../src/server/consoleLogin.js";
import {
  mintConsoleLoginCode,
  redeemConsoleLoginCode,
  resetConsoleLoginCodesForTests,
} from "../src/server/consoleLoginCode.js";
import { resetConsoleLoginAttemptsForTests } from "../src/server/consoleLogin.js";

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
