import { describe, expect, it } from "vitest";
import { isSecretRef, redactSecrets, resolveSecretRef } from "../src/channels/secrets.js";

describe("secret references", () => {
  it("accepts only env: references", () => {
    expect(isSecretRef("env:SLACK_BOT_TOKEN")).toBe(true);
    expect(isSecretRef("env:1BAD")).toBe(false);
    expect(isSecretRef("xoxb-literal")).toBe(false);
    expect(isSecretRef("file:/etc/token")).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });

  it("resolves a reference and trims one file newline", () => {
    expect(resolveSecretRef("env:TOK", { TOK: "abc" }, { connectionId: "c", field: "f" })).toBe("abc");
  });
});

describe("redactSecrets", () => {
  it("removes every occurrence of each secret", () => {
    expect(redactSecrets("token=abcd1234 again abcd1234 and other", ["abcd1234", "other"])).toBe("token=[redacted] again [redacted] and [redacted]");
  });

  it("ignores values too short to be a safe match", () => {
    expect(redactSecrets("a b c", ["a"])).toBe("a b c");
  });
});
