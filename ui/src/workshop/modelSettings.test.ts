import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSHOP_MODEL,
  resolveWorkshopModel,
} from "./modelSettings";

describe("resolveWorkshopModel", () => {
  it("prefers session override over settings default and profile fallback", () => {
    expect(
      resolveWorkshopModel({
        sessionOverride: "openai/gpt-5",
        settingsDefault: "anthropic/claude-opus-4",
        profileDefault: "google/gemini-2.5-pro",
      }),
    ).toBe("openai/gpt-5");
  });

  it("uses Settings workshop model when session override is empty", () => {
    expect(
      resolveWorkshopModel({
        sessionOverride: "  ",
        settingsDefault: "openai/gpt-4.1",
      }),
    ).toBe("openai/gpt-4.1");
  });

  it("falls back to profile default then hard-coded default", () => {
    expect(
      resolveWorkshopModel({
        sessionOverride: null,
        settingsDefault: null,
        profileDefault: "google/gemini-2.5-flash",
      }),
    ).toBe("google/gemini-2.5-flash");
    expect(resolveWorkshopModel({})).toBe(DEFAULT_WORKSHOP_MODEL);
  });
});
