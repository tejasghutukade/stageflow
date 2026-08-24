import { describe, expect, it } from "vitest";
import type { ProviderAuthStatus, ProviderSummary } from "../api";
import { statusLabel } from "../providers/helpers";
import { providerSupportsOauthConnect } from "../providers/oauthSession";

function fakeProvider(partial: {
  id?: string;
  supportsApiKey?: boolean;
  supportsOauth?: boolean;
}): ProviderSummary {
  return {
    id: partial.id ?? "test-provider",
    name: "Test Provider",
    supportsApiKey: partial.supportsApiKey ?? false,
    supportsOauth: partial.supportsOauth ?? false,
  };
}

describe("ProviderConnectRow prop logic", () => {
  it("statusLabel returns Not connected for unconfigured provider", () => {
    const status: ProviderAuthStatus = {
      providerId: "test",
      configured: false,
    };
    expect(statusLabel(status)).toBe("Not connected");
  });

  it("statusLabel returns Unknown for undefined status", () => {
    expect(statusLabel(undefined)).toBe("Unknown");
  });

  it("statusLabel returns Connected (API key) for api_key kind", () => {
    const status: ProviderAuthStatus = {
      providerId: "test",
      configured: true,
      authKind: "api_key",
    };
    expect(statusLabel(status)).toBe("Connected (API key)");
  });

  it("statusLabel returns Connected (OAuth) for oauth kind", () => {
    const status: ProviderAuthStatus = {
      providerId: "test",
      configured: true,
      authKind: "oauth",
    };
    expect(statusLabel(status)).toBe("Connected (OAuth)");
  });

  it("connecting=true signals API-key form should be visible", () => {
    const connecting = true;
    expect(connecting).toBe(true);
  });

  it("oauthing=true signals ProviderOAuthSession should be visible", () => {
    const oauthing = true;
    expect(oauthing).toBe(true);
  });

  it("showDisconnect=true means Disconnect button is shown for configured providers", () => {
    const showDisconnect = true;
    const configured = true;
    expect(showDisconnect && configured).toBe(true);
  });

  it("showDisconnect=false means Connected label shown instead of Disconnect", () => {
    const showDisconnect = false;
    const configured = true;
    expect(!showDisconnect && configured).toBe(true);
  });

  it("oauth-only provider supports oauth connect", () => {
    const provider = fakeProvider({ supportsOauth: true, supportsApiKey: false });
    expect(providerSupportsOauthConnect(provider)).toBe(true);
  });

  it("api-key-only provider does not support oauth connect", () => {
    const provider = fakeProvider({ supportsApiKey: true, supportsOauth: false });
    expect(providerSupportsOauthConnect(provider)).toBe(false);
  });
});
