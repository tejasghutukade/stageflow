import { afterEach, describe, expect, it, vi } from "vitest";
import { readThemePreference, writeThemePreference } from "./themePreference";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("themePreference", () => {
  it("reads and writes sf-theme", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    });
    writeThemePreference("dark");
    expect(data.get("sf-theme")).toBe("dark");
    expect(data.has("stageflow-theme")).toBe(false);
    expect(readThemePreference()).toBe("dark");
  });
});
