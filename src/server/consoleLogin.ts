import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackRemoteAddress } from "./allowedHosts.js";
import { mintConsoleLoginCode, redeemConsoleLoginCode } from "./consoleLoginCode.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const MAX_BODY_BYTES = 4096;
const failures: number[] = [];

export function resetConsoleLoginAttemptsForTests(): void {
  failures.length = 0;
}

function recentFailures(now: number): number {
  const live = failures.filter((at) => now - at < WINDOW_MS);
  failures.length = 0;
  failures.push(...live);
  return failures.length;
}

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Exchange a one-time code for the control token. A valid code always works: codes are 128-bit, so the
 * limiter only counts failed attempts and cannot be used by another local process to lock out a real login.
 */
export async function handleConsoleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  getToken: () => string | undefined,
): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    json(res, 403, { error: "loopback only" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: "request too large" });
      if (typeof req.destroy === "function") req.destroy();
      return;
    }
    body = undefined;
  }
  const code =
    body !== null && typeof body === "object" && "code" in body
      ? (body as { code?: unknown }).code
      : undefined;
  const token = getToken();
  if (
    typeof code === "string" &&
    token !== undefined &&
    token.length > 0 &&
    redeemConsoleLoginCode(code)
  ) {
    json(res, 200, { token });
    return;
  }
  const now = Date.now();
  if (recentFailures(now) >= MAX_FAILURES) {
    json(res, 429, { error: "too many requests" });
    return;
  }
  failures.push(now);
  json(res, 401, { error: "unauthorized" });
}

export function handleConsoleLoginMint(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  json(res, 200, { code: mintConsoleLoginCode() });
}
