import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProviderAuth,
  fetchProviderLoginSession,
  fetchProviders,
  fetchProvidersDetect,
  postCredentialSource,
  postProviderApiKey,
  postProviderLoginAnswer,
  postProviderLoginCancel,
  postProviderLogout,
  postProviderOauthLogin,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider api clients", () => {
  it("GET /api/providers returns the live list shape", async () => {
    const body = {
      authShell: "pi" as const,
      via: "pi" as const,
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          supportsApiKey: true,
          supportsOauth: false,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(fetchProviders()).resolves.toEqual(body);
    expect(fetch).toHaveBeenCalledWith(
      "/api/providers",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("GET /api/providers/detect returns usability without secrets", async () => {
    const body = {
      piHomeUsable: true,
      provisional: true,
      source: "pi_home" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    const result = await fetchProvidersDetect();
    expect(result.piHomeUsable).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/apiKey|token|sk-/i);
  });

  it("GET provider auth wraps status metadata", async () => {
    const body = {
      provider: {
        providerId: "openai",
        configured: true,
        authKind: "api_key" as const,
        source: "stored",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(fetchProviderAuth("openai")).resolves.toEqual(body);
  });

  it("POST login sends api key and does not echo secrets in the result", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        provider: {
          providerId: "openai",
          configured: true,
          authKind: "api_key",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await postProviderApiKey("openai", "sk-secret");
    expect(result).toEqual({
      ok: true,
      provider: {
        providerId: "openai",
        configured: true,
        authKind: "api_key",
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/openai/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ authType: "api_key", apiKey: "sk-secret" }),
      }),
    );
  });

  it("POST login surfaces error string from non-OK JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "apiKey is required" }, { status: 400 }),
      ),
    );
    await expect(postProviderApiKey("openai", "")).resolves.toEqual({
      ok: false,
      status: 400,
      error: "apiKey is required",
    });
  });

  it("POST logout and credential source hit expected paths", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(_input);
        if (url.endsWith("/logout")) {
          return Response.json({
            ok: true,
            provider: { providerId: "openai", configured: false },
          });
        }
        return Response.json({
          maxConcurrent: 2,
          credentialSource: "sf_owned",
          binding: { source: "sf_owned", provisional: false },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    await postProviderLogout("openai");
    await postCredentialSource("sf_owned");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/providers/openai/logout");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/settings");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ credentialSource: "sf_owned" }),
      }),
    );
  });

  it("oauth session start/poll/answer/cancel never echo answer values", async () => {
    const canary = "oauth-answer-canary-UI";
    const session = {
      id: "sess-1",
      providerId: "anthropic",
      authType: "oauth" as const,
      status: "running" as const,
      events: [
        { type: "auth_url" as const, url: "https://example.test/oauth" },
      ],
      pendingPrompt: {
        type: "manual_code" as const,
        message: "Paste",
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/login") && init?.method === "POST") {
        return Response.json({ ok: true, session });
      }
      if (url.includes("/login/sess-1/answer")) {
        return Response.json({
          ok: true,
          session: { ...session, pendingPrompt: undefined },
        });
      }
      if (url.includes("/login/sess-1/cancel")) {
        return Response.json({
          ok: true,
          session: { ...session, status: "cancelled" },
        });
      }
      if (url.endsWith("/login/sess-1")) {
        return Response.json({ session });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = await postProviderOauthLogin("anthropic");
    expect(started.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/anthropic/login",
      expect.objectContaining({
        body: JSON.stringify({ authType: "oauth" }),
      }),
    );

    await expect(
      fetchProviderLoginSession("anthropic", "sess-1"),
    ).resolves.toEqual({ session });

    const answered = await postProviderLoginAnswer(
      "anthropic",
      "sess-1",
      canary,
    );
    expect(answered.ok).toBe(true);
    expect(JSON.stringify(answered)).not.toContain(canary);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/anthropic/login/sess-1/answer",
      expect.objectContaining({
        body: JSON.stringify({ value: canary }),
      }),
    );

    const cancelled = await postProviderLoginCancel("anthropic", "sess-1");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.ok && cancelled.session.status).toBe("cancelled");
  });
});
