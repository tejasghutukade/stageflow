import { describe, expect, it } from "vitest";
import {
  clearNamedSecretsForTests,
  registerNamedSecrets,
} from "../src/logging/namedSecrets.js";
import { redactString, stripUrlUserinfo } from "../src/logging/redact.js";
import { redactSecrets } from "../src/agent/streamLogRedact.js";

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
});
