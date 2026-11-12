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
const MAX_ATTEMPTS = 10;
const attempts: number[] = [];

export function resetConsoleLoginAttemptsForTests(): void {
  attempts.length = 0;
}

function allowAttempt(now: number): boolean {
  const live = attempts.filter((at) => now - at < WINDOW_MS);
  attempts.length = 0;
  attempts.push(...live);
  if (attempts.length >= MAX_ATTEMPTS) return false;
  attempts.push(now);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handleConsoleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  getToken: () => string | undefined,
): Promise<void> {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    json(res, 403, { error: "loopback only" });
    return;
  }
  if (!allowAttempt(Date.now())) {
    json(res, 429, { error: "too many requests" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const code =
    body !== null && typeof body === "object" && "code" in body
      ? (body as { code?: unknown }).code
      : undefined;
  if (typeof code !== "string" || !redeemConsoleLoginCode(code)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const token = getToken();
  if (token === undefined || token.length === 0) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  json(res, 200, { token });
}

export function handleConsoleLoginMint(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  json(res, 200, { code: mintConsoleLoginCode() });
}
