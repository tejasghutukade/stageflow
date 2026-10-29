import { describe, expect, it } from "vitest";
import { normalizeHotkeyKey, textFieldKeepsKey } from "./keys";

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

const field = { tagName: "INPUT" } as unknown as EventTarget;

describe("textFieldKeepsKey", () => {
  const base = {
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    target: field,
  };

  it("leaves word and line movement in the field", () => {
    expect(textFieldKeepsKey({ ...base, key: "ArrowLeft", altKey: true })).toBe(true);
    expect(textFieldKeepsKey({ ...base, key: "ArrowRight", metaKey: true })).toBe(true);
    expect(textFieldKeepsKey({ ...base, key: "ArrowUp", shiftKey: true })).toBe(true);
    expect(textFieldKeepsKey({ ...base, key: "Home" })).toBe(true);
    expect(textFieldKeepsKey({ ...base, key: "End" })).toBe(true);
  });

  it("lets a one-line search keep plain up and down for the list", () => {
    expect(textFieldKeepsKey({ ...base, key: "ArrowDown" })).toBe(false);
    expect(textFieldKeepsKey({ ...base, key: "ArrowUp" })).toBe(false);
  });

  it("ignores arrows when focus is not in a field", () => {
    expect(
      textFieldKeepsKey({ ...base, key: "ArrowLeft", altKey: true, target: { tagName: "DIV" } as unknown as EventTarget }),
    ).toBe(false);
  });
});
