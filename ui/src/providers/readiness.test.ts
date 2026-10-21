import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProviderAuthReadiness } from "./readiness";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadProviderAuthReadiness", () => {
  it("blocks when credential source is unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            provisional: true,
            source: "sf_owned",
          });
        }
        if (String(url) === "/api/providers") {
          return Response.json({
            authShell: "pi",
            via: "pi",
            providers: [],
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const result = await loadProviderAuthReadiness();
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/Connect providers/i);
    expect(result.message).toMatch(/Stageflow/);
    expect(result.message).not.toMatch(/Software Factory/);
    expect(result.message).not.toMatch(/software-factory/);
  });

  it("allows sf_owned once a provider is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            credentialSource: "sf_owned",
            provisional: false,
            source: "sf_owned",
          });
        }
        if (String(url) === "/api/providers") {
          return Response.json({
            authShell: "pi",
            via: "pi",
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                supportsApiKey: true,
                supportsOauth: false,
              },
            ],
          });
        }
        if (String(url).endsWith("/auth")) {
          return Response.json({
            provider: {
              providerId: "openai",
              configured: true,
              authKind: "api_key",
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    await expect(loadProviderAuthReadiness()).resolves.toEqual({
      ready: true,
      credentialSource: "sf_owned",
    });
  });

  it("allows Cursor SDK when no Pi provider keys are stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            credentialSource: "sf_owned",
            provisional: false,
            source: "sf_owned",
            cursorSdkReady: true,
            cursorApiKeyConfigured: true,
          });
        }
        if (String(url) === "/api/providers") {
          return Response.json({
            authShell: "pi",
            via: "pi",
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                supportsApiKey: true,
                supportsOauth: false,
              },
            ],
          });
        }
        if (String(url).endsWith("/auth")) {
          return Response.json({
            provider: { providerId: "openai", configured: false },
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    await expect(loadProviderAuthReadiness()).resolves.toEqual({
      ready: true,
      credentialSource: "sf_owned",
    });
  });

  it("blocks sf_owned with zero configured providers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            credentialSource: "sf_owned",
            provisional: false,
            source: "sf_owned",
          });
        }
        if (String(url) === "/api/providers") {
          return Response.json({
            authShell: "pi",
            via: "pi",
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                supportsApiKey: true,
                supportsOauth: false,
              },
            ],
          });
        }
        if (String(url).endsWith("/auth")) {
          return Response.json({
            provider: { providerId: "openai", configured: false },
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const result = await loadProviderAuthReadiness();
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/API key/i);
  });
});
