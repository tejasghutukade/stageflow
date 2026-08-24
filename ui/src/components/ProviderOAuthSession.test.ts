import { describe, expect, it } from "vitest";
import type { LoginSessionProjection } from "../api";
import {
  isTerminalSession,
  latestAuthUrl,
  promptInputKind,
} from "../providers/oauthSession";

/** UI wiring projections used by ProviderOAuthSession without mounting React. */
describe("ProviderOAuthSession wiring projections", () => {
  it("auth_url → manual_code → completed sequence drives UI surfaces", () => {
    const running: LoginSessionProjection = {
      id: "s1",
      providerId: "anthropic",
      authType: "oauth",
      status: "running",
      events: [
        {
          type: "auth_url",
          url: "https://example.test/oauth",
          instructions: "Open browser",
        },
      ],
      pendingPrompt: {
        type: "manual_code",
        message: "Paste redirect URL",
        placeholder: "https://...",
      },
    };
    expect(latestAuthUrl(running.events)?.url).toBe(
      "https://example.test/oauth",
    );
    expect(promptInputKind(running.pendingPrompt!)).toBe("text");
    expect(isTerminalSession(running)).toBe(false);

    const completed: LoginSessionProjection = {
      ...running,
      status: "completed",
      events: running.events,
      pendingPrompt: undefined,
      provider: {
        providerId: "anthropic",
        configured: true,
        authKind: "oauth",
      },
    };
    expect(isTerminalSession(completed)).toBe(true);
    expect(completed.provider?.configured).toBe(true);
  });

  it("device_code and select prompts are distinct surfaces", () => {
    const device: LoginSessionProjection = {
      id: "s2",
      providerId: "github-copilot",
      authType: "oauth",
      status: "running",
      events: [
        {
          type: "device_code",
          userCode: "WXYZ-9999",
          verificationUri: "https://github.com/login/device",
        },
      ],
      pendingPrompt: {
        type: "select",
        message: "Account type",
        options: [
          { id: "enterprise", label: "Enterprise" },
          { id: "personal", label: "Personal" },
        ],
      },
    };
    expect(device.events[0]?.type).toBe("device_code");
    expect(promptInputKind(device.pendingPrompt!)).toBe("select");
  });

  it("cancel / failed are terminal without retaining answers", () => {
    const cancelled: LoginSessionProjection = {
      id: "s3",
      providerId: "openai-codex",
      authType: "oauth",
      status: "cancelled",
      events: [],
      error: { message: "Login cancelled" },
    };
    expect(isTerminalSession(cancelled)).toBe(true);
    expect(JSON.stringify(cancelled)).not.toMatch(/sk-|access_token|secret/i);
  });

  it("loopback race clears pending manual_code without failing the session", () => {
    const runningWithPrompt: LoginSessionProjection = {
      id: "s4",
      providerId: "openrouter",
      authType: "oauth",
      status: "running",
      events: [
        {
          type: "auth_url",
          url: "https://example.test/oauth",
          instructions: "Open browser",
        },
      ],
      pendingPrompt: {
        type: "manual_code",
        message: "Paste redirect URL",
      },
    };
    expect(runningWithPrompt.pendingPrompt?.type).toBe("manual_code");

    const afterLoopbackWin: LoginSessionProjection = {
      ...runningWithPrompt,
      pendingPrompt: undefined,
    };
    expect(afterLoopbackWin.pendingPrompt).toBeUndefined();
    expect(isTerminalSession(afterLoopbackWin)).toBe(false);
    expect(afterLoopbackWin.error).toBeUndefined();

    const completed: LoginSessionProjection = {
      ...afterLoopbackWin,
      status: "completed",
      provider: {
        providerId: "openrouter",
        configured: true,
        authKind: "oauth",
      },
    };
    expect(isTerminalSession(completed)).toBe(true);
    expect(completed.error).toBeUndefined();
  });

  it("CredentialSynchronizationError warning is soft success copy", () => {
    const completed: LoginSessionProjection = {
      id: "s5",
      providerId: "anthropic",
      authType: "oauth",
      status: "completed",
      events: [],
      warning: {
        message:
          "Connected, but model catalog sync failed. Credentials were saved — you can retry later without disconnecting.",
      },
      provider: {
        providerId: "anthropic",
        configured: true,
        authKind: "oauth",
      },
    };
    expect(isTerminalSession(completed)).toBe(true);
    expect(completed.provider?.configured).toBe(true);
    expect(completed.warning?.message).toMatch(/without disconnecting/i);
  });
});
