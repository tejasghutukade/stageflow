import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_STAGE_PATTERNS, redactString } from "../src/logging/redact.js";
import { redactBrowserSecrets } from "../src/agent/streamLogRedact.js";
import { createStageStreamLogWriter } from "../src/runtime/stageStreamLog.js";

const LI_AT = "AQEDAR0v3xYz9abcDEF1234567890ghIJKlmnOPqrSTuv";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

const samples: Array<[string, string, string]> = [
  ["cookies json", `{"name":"li_at","value":"${LI_AT}","domain":".example.com"}`, LI_AT],
  ["cookies json reversed", `{"value":"${LI_AT}","domain":".example.com","path":"/"}`, LI_AT],
  ["cookies table", `li_at   ${LI_AT}   .example.com`, LI_AT],
  ["Cookie header", `Cookie: foo=bar; session=${LI_AT}`, LI_AT],
  ["Set-Cookie header", `Set-Cookie: sid=${LI_AT}; HttpOnly; Secure`, LI_AT],
  ["header json", `{"headers":{"Cookie":"a=${LI_AT}"}}`, LI_AT],
  ["Authorization header", `authorization: Basic ${LI_AT}`, LI_AT],
  ["x-csrf", `X-CSRF-Token: ${LI_AT}`, LI_AT],
  ["jwt in storage", `localStorage: user_jwt=${JWT}`, JWT],
  ["storage json key", `{"auth_session_blob":"${LI_AT}"}`, LI_AT],
  ["state token", `access_token=${LI_AT}`, LI_AT],
];

describe("browser output redaction", () => {
  it.each(samples)("redacts %s", (_label, text, secret) => {
    const out = redactString(text, { patterns: BROWSER_STAGE_PATTERNS });
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary prose alone", () => {
    const text = "Opened https://example.com and the author wrote a title.";
    expect(redactString(text, { patterns: BROWSER_STAGE_PATTERNS })).toBe(text);
  });

  it("does not apply browser patterns to the global default", () => {
    const text = `{"name":"li_at","value":"${LI_AT}","domain":".example.com"}`;
    expect(redactString(text)).toBe(text);
  });
});

describe("stream log", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sf-redact-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never persists cookie values from agent-browser output", async () => {
    const file = path.join(dir, "stream.log");
    const writer = createStageStreamLogWriter(file, {
      flushThrottleMs: 1,
      redact: redactBrowserSecrets,
    });
    for (const [, text] of samples) writer.onDelta(`${text}\n`);
    await writer.flush();
    const log = await readFile(file, "utf8");
    expect(log).not.toContain(LI_AT);
    expect(log).not.toContain(JWT);
  });
});
