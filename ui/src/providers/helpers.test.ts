import { describe, expect, it } from "vitest";
import {
  PROVIDERS_PI_COPY,
  countConfigured,
  isProviderAuthReady,
  needsFirstRun,
  providerAllowsApiKey,
  providerOauthOnly,
  statusLabel,
} from "./helpers";

describe("provider helpers", () => {
  it("needsFirstRun when credential source is unset or no provider is configured", () => {
    expect(
      needsFirstRun(
        {
          provisional: true,
          source: "sf_owned",
        },
        1,
      ),
    ).toBe(false);
    expect(
      needsFirstRun(
        {
          credentialSource: "sf_owned",
          provisional: false,
          source: "sf_owned",
        },
        0,
      ),
    ).toBe(true);
    expect(
      needsFirstRun(
        {
          credentialSource: "sf_owned",
          provisional: false,
          source: "sf_owned",
          cursorSdkReady: true,
          cursorApiKeyConfigured: true,
        },
        0,
      ),
    ).toBe(false);
  });

  it("classifies api-key vs oauth-only rows", () => {
    expect(
      providerAllowsApiKey({
        id: "a",
        name: "A",
        supportsApiKey: true,
        supportsOauth: true,
      }),
    ).toBe(true);
    expect(
      providerOauthOnly({
        id: "b",
        name: "B",
        supportsApiKey: false,
        supportsOauth: true,
      }),
    ).toBe(true);
  });

  it("readiness requires at least one configured provider", () => {
    expect(
      isProviderAuthReady({ credentialSource: undefined, configuredCount: 0 }),
    ).toBe(false);
    expect(
      isProviderAuthReady({ credentialSource: "sf_owned", configuredCount: 0 }),
    ).toBe(false);
    expect(
      isProviderAuthReady({ credentialSource: "sf_owned", configuredCount: 1 }),
    ).toBe(true);
    expect(
      isProviderAuthReady({
        credentialSource: "sf_owned",
        configuredCount: 0,
        detect: {
          credentialSource: "sf_owned",
          provisional: false,
          source: "sf_owned",
          cursorSdkReady: true,
          cursorApiKeyConfigured: true,
        },
      }),
    ).toBe(true);
  });

  it("status labels never include secrets and copy names Pi", () => {
    expect(
      statusLabel({
        providerId: "openai",
        configured: true,
        authKind: "api_key",
      }),
    ).toBe("Connected (API key)");
    expect(
      countConfigured([undefined, { providerId: "x", configured: true }]),
    ).toBe(1);
    expect(PROVIDERS_PI_COPY).toMatch(/Stageflow/);
    expect(PROVIDERS_PI_COPY).not.toMatch(/Software Factory/);
    expect(PROVIDERS_PI_COPY).not.toMatch(/software-factory/);
    expect(PROVIDERS_PI_COPY.toLowerCase()).not.toMatch(/non-pi llm stack/);
  });
});
