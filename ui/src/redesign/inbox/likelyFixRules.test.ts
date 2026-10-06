import { describe, expect, it } from "vitest";
import { matchLikelyFix } from "./likelyFixRules";

describe("matchLikelyFix", () => {
  it("returns null for empty reason", () => {
    expect(matchLikelyFix(undefined)).toBeNull();
    expect(matchLikelyFix("   ")).toBeNull();
  });

  it("links provider auth issues to settings", () => {
    const fix = matchLikelyFix("HTTP 401: invalid API key for model call");
    expect(fix).not.toBeNull();
    expect(fix?.settingsHref).toBe("#/settings?section=providers");
    expect(fix?.title).toMatch(/API key/i);
  });

  it("prefers OpenRouter-specific copy", () => {
    const fix = matchLikelyFix("OpenRouter returned 402: insufficient credits");
    expect(fix?.title).toMatch(/OpenRouter/i);
    expect(fix?.settingsHref).toBe("#/settings?section=providers");
  });

  it("matches anthropic provider failures", () => {
    const fix = matchLikelyFix("anthropic: connection reset by peer");
    expect(fix?.title).toMatch(/Anthropic/i);
  });
});
