import { describe, expect, it } from "vitest";
import fixture from "../ui/src/redesign/connections/metaFixture.json" with { type: "json" };
import { CHANNEL_ERROR_INFO } from "../src/channels/errorInfo.js";
import { channelProviders } from "../src/channels/providers.js";

/**
 * The console's tests use this fixture instead of provider tables of their own. This test keeps
 * it equal to what the host really serves. Regenerate it after changing a provider description
 * or an error explanation:
 *   npx tsx scripts/generate-channel-meta-fixture.ts
 */
describe("console meta fixture", () => {
  it("matches the provider descriptions the host serves", () => {
    const actual = channelProviders().filter(provider => provider.id !== "fake").map(provider => ({ id: provider.id, ...provider.meta }));
    expect(fixture.providers.map(provider => provider.id).sort()).toEqual(actual.map(provider => provider.id).sort());
    for (const provider of actual) expect(fixture.providers.find(entry => entry.id === provider.id)).toEqual(JSON.parse(JSON.stringify(provider)));
  });

  it("matches the error catalogue", () => {
    const actual = Object.fromEntries(Object.entries(CHANNEL_ERROR_INFO).map(([code, info]) => [code, { reason: info.reason, ...(info.hint ? { hint: info.hint } : {}) }]));
    expect(fixture.errors).toEqual(actual);
  });
});
