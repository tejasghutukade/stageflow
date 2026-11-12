import { randomBytes } from "node:crypto";

const TTL_MS = 60_000;
const MAX_CODES = 5;

type Entry = { code: string; expiresAt: number };

const codes: Entry[] = [];

export function resetConsoleLoginCodesForTests(): void {
  codes.length = 0;
}

export function mintConsoleLoginCode(now: number = Date.now()): string {
  const code = randomBytes(16).toString("hex");
  const live = codes.filter((entry) => entry.expiresAt > now);
  live.push({ code, expiresAt: now + TTL_MS });
  while (live.length > MAX_CODES) live.shift();
  codes.length = 0;
  codes.push(...live);
  return code;
}

export function redeemConsoleLoginCode(code: string, now: number = Date.now()): boolean {
  const index = codes.findIndex((entry) => entry.code === code && entry.expiresAt > now);
  if (index < 0) return false;
  codes.splice(index, 1);
  return true;
}
