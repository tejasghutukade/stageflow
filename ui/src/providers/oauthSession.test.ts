import { describe, expect, it } from "vitest";
import {
  OAUTH_LOOPBACK_CAVEAT,
  OAUTH_PASTE_HINT,
  isTerminalSession,
  latestAuthUrl,
  latestDeviceCode,
  latestInfoLinks,
  latestStatusMessage,
  promptInputKind,
  providerSupportsOauthConnect,
} from "./oauthSession";

describe("oauth session helpers", () => {
  it("projects latest auth_url, device_code, and info links", () => {
    const events = [
      { type: "progress" as const, message: "Starting…" },
      {
        type: "auth_url" as const,
        url: "https://example.test/a",
        instructions: "Sign in",
      },
      {
        type: "device_code" as const,
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
        expiresInSeconds: 900,
      },
      {
        type: "info" as const,
        message: "Waiting for approval",
        links: [{ url: "https://example.test/help", label: "Help" }],
      },
    ];
    expect(latestAuthUrl(events)?.url).toBe("https://example.test/a");
    expect(latestDeviceCode(events)?.userCode).toBe("ABCD-1234");
    expect(latestDeviceCode(events)?.expiresInSeconds).toBe(900);
    expect(latestStatusMessage(events)).toBe("Waiting for approval");
    expect(latestInfoLinks(events)).toEqual([
      { url: "https://example.test/help", label: "Help" },
    ]);
  });

  it("classifies prompt input kinds and terminal statuses", () => {
    expect(
      promptInputKind({ type: "secret", message: "key" }),
    ).toBe("password");
    expect(
      promptInputKind({ type: "manual_code", message: "paste" }),
    ).toBe("text");
    expect(
      promptInputKind({
        type: "select",
        message: "pick",
        options: [{ id: "a", label: "A" }],
      }),
    ).toBe("select");
    expect(isTerminalSession({ status: "completed" })).toBe(true);
    expect(isTerminalSession({ status: "running" })).toBe(false);
  });

  it("documents loopback caveat and oauth connect capability", () => {
    expect(OAUTH_LOOPBACK_CAVEAT).toMatch(/local callback/i);
    expect(OAUTH_LOOPBACK_CAVEAT).toMatch(/Stageflow/);
    expect(OAUTH_LOOPBACK_CAVEAT).not.toMatch(/Software Factory/);
    expect(OAUTH_LOOPBACK_CAVEAT).not.toMatch(/software-factory/);
    expect(OAUTH_PASTE_HINT).toMatch(/paste/i);
    expect(
      providerSupportsOauthConnect({ supportsOauth: true }),
    ).toBe(true);
    expect(
      providerSupportsOauthConnect({ supportsOauth: false }),
    ).toBe(false);
  });
});
