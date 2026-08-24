import { describe, expect, it } from "vitest";
import {
  PROVIDERS_PI_COPY,
  countConfigured,
  defaultOfferChoice,
  isProviderAuthReady,
  needsFirstRun,
  providerAllowsApiKey,
  providerOauthOnly,
  statusLabel,
} from "./helpers";

describe("provider helpers", () => {
  it("needsFirstRun when credentialSource is unset", () => {
    expect(
      needsFirstRun({
        piHomeUsable: true,
        provisional: true,
        source: "pi_home",
      }),
    ).toBe(true);
    expect(
      needsFirstRun({
        piHomeUsable: true,
        credentialSource: "pi_home",
        provisional: false,
        source: "pi_home",
      }),
    ).toBe(false);
  });

  it("preselects pi_home when usable (AE-S3-2)", () => {
    expect(defaultOfferChoice(true)).toBe("pi_home");
    expect(defaultOfferChoice(false)).toBe("sf_owned");
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

  it("readiness requires sf_owned configured providers", () => {
    expect(
      isProviderAuthReady({ credentialSource: undefined, configuredCount: 0 }),
    ).toBe(false);
    expect(
      isProviderAuthReady({ credentialSource: "pi_home", configuredCount: 0 }),
    ).toBe(true);
    expect(
      isProviderAuthReady({ credentialSource: "sf_owned", configuredCount: 0 }),
    ).toBe(false);
    expect(
      isProviderAuthReady({ credentialSource: "sf_owned", configuredCount: 1 }),
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
    expect(PROVIDERS_PI_COPY).toMatch(/Pi/);
    expect(PROVIDERS_PI_COPY).toMatch(/Stageflow/);
    expect(PROVIDERS_PI_COPY).not.toMatch(/Software Factory/);
    expect(PROVIDERS_PI_COPY).not.toMatch(/software-factory/);
    expect(PROVIDERS_PI_COPY.toLowerCase()).not.toMatch(/non-pi llm stack/);
  });
});
