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
            piHomeUsable: false,
            provisional: true,
            source: "sf_owned",
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

  it("allows pi_home once persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            piHomeUsable: true,
            credentialSource: "pi_home",
            provisional: false,
            source: "pi_home",
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    await expect(loadProviderAuthReadiness()).resolves.toEqual({
      ready: true,
      credentialSource: "pi_home",
    });
  });

  it("blocks sf_owned with zero configured providers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/detect")) {
          return Response.json({
            piHomeUsable: false,
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
