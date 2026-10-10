import { describe, expect, it } from "vitest";
import { normalizeHotkeyKey } from "./keys";

function fakeKey(
  key: string,
  opts?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
): KeyboardEvent {
  return {
    key,
    metaKey: opts?.metaKey ?? false,
    ctrlKey: opts?.ctrlKey ?? false,
    altKey: opts?.altKey ?? false,
    shiftKey: opts?.shiftKey ?? false,
  } as KeyboardEvent;
}

describe("normalizeHotkeyKey", () => {
  it("lowercases single-letter keys", () => {
    expect(normalizeHotkeyKey(fakeKey("J"))).toBe("j");
  });

  it("prefixes mod for meta or control", () => {
    expect(normalizeHotkeyKey(fakeKey("k", { metaKey: true }))).toBe("mod+k");
  });

  it("uses the physical letter when alt changes the produced key", () => {
    const event = { ...fakeKey("Ï", { altKey: true, shiftKey: true }), code: "KeyF" } as KeyboardEvent;
    expect(normalizeHotkeyKey(event)).toBe("alt+shift+f");
  });
});
