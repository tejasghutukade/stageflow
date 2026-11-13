import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearNamedSecretsForTests,
  getNamedSecrets,
  loadNamedSecretsFromAttemptDir,
  REDACTION_SECRETS_FILENAME,
  registerNamedSecrets,
} from "../src/logging/namedSecrets.js";
import { redactString, stripUrlUserinfo } from "../src/logging/redact.js";
import { redactSecrets } from "../src/agent/streamLogRedact.js";

describe("GitHub token prefixes", () => {
  it("replaces each prefix in a log line and leaves a short lookalike", () => {
    const tail = "Ab12_cd34EF567890abcd";
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_${tail}`;
      expect(redactString(`log line ${token} end`)).toBe("log line [redacted] end");
    }
    const lookalike = `gho_${"a".repeat(19)}`;
    expect(redactString(`log line ${lookalike} end`)).toBe(`log line ${lookalike} end`);
  });
});

describe("value-based redaction", () => {
  it("redacts exact, base64, and URL-encoded forms with named marker", () => {
    clearNamedSecretsForTests();
    const value = "super-secret-token";
    registerNamedSecrets([{ name: "MY_TOKEN", value }]);
    const text = `a ${value} b ${Buffer.from(value).toString("base64")} c ${encodeURIComponent(value)}`;
    expect(redactString(text, { namedSecrets: [{ name: "MY_TOKEN", value }] })).toBe(
      "a [redacted:MY_TOKEN] b [redacted:MY_TOKEN] c [redacted:MY_TOKEN]",
    );
    expect(redactSecrets(`leak ${value}`)).toContain("[redacted:MY_TOKEN]");
  });

  it("skips short and common-word values", () => {
    expect(
      redactString("password is password", {
        namedSecrets: [{ name: "P", value: "password" }],
      }),
    ).toBe("password is password");
    expect(
      redactString("short ab", { namedSecrets: [{ name: "S", value: "short" }] }),
    ).toBe("short ab");
  });

  it("strips proxy userinfo", () => {
    expect(stripUrlUserinfo("http://user:pass@proxy.example:8080")).toBe(
      "http://proxy.example:8080/",
    );
  });

  it("loadNamedSecretsFromAttemptDir registers worker sink secrets", async () => {
    clearNamedSecretsForTests();
    const attemptDir = await mkdtemp(path.join(tmpdir(), "sf-redact-load-"));
    try {
      const value = "worker-sink-secret-xx";
      await writeFile(
        path.join(attemptDir, REDACTION_SECRETS_FILENAME),
        JSON.stringify([{ name: "WORKER_TOKEN", value }]),
        { mode: 0o600 },
      );
      loadNamedSecretsFromAttemptDir(attemptDir);
      expect(getNamedSecrets()).toEqual([{ name: "WORKER_TOKEN", value }]);
      expect(redactSecrets(`leak ${value}`)).toContain("[redacted:WORKER_TOKEN]");
      await expect(
        readFile(path.join(attemptDir, REDACTION_SECRETS_FILENAME), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearNamedSecretsForTests();
      await rm(attemptDir, { recursive: true, force: true });
    }
  });
});
