import { describe, expect, it } from "vitest";
import { buildKeyEvent, modifierMask, textToCharEvents, type KeyEventLike } from "./keys";

const base: KeyEventLike = {
  key: "a",
  code: "KeyA",
  keyCode: 65,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("buildKeyEvent", () => {
  it("printable keys carry text on keyDown only", () => {
    expect(buildKeyEvent(base, "keyDown")).toEqual({
      type: "input_keyboard",
      eventType: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
      text: "a",
    });
    expect(buildKeyEvent(base, "keyUp")?.text).toBeUndefined();
  });

  it("Enter carries a carriage return", () => {
    const e = buildKeyEvent({ ...base, key: "Enter", code: "Enter", keyCode: 13 }, "keyDown");
    expect(e?.text).toBe("\r");
    expect(e?.windowsVirtualKeyCode).toBe(13);
  });

  it.each([
    ["Backspace", 8],
    ["Tab", 9],
    ["Delete", 46],
    ["ArrowLeft", 37],
    ["Escape", 27],
    ["Home", 36],
  ])("%s carries only the virtual key code", (key, keyCode) => {
    const e = buildKeyEvent({ ...base, key, code: key, keyCode }, "keyDown");
    expect(e?.text).toBeUndefined();
    expect(e?.windowsVirtualKeyCode).toBe(keyCode);
  });

  it("builds the modifier mask and skips text for ctrl/meta chords", () => {
    expect(modifierMask({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifierMask({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBe(8);
    const e = buildKeyEvent({ ...base, ctrlKey: true }, "keyDown");
    expect(e?.modifiers).toBe(2);
    expect(e?.text).toBeUndefined();
  });

  it("ignores composing, IME and paste chords", () => {
    expect(buildKeyEvent({ ...base, isComposing: true }, "keyDown")).toBeNull();
    expect(buildKeyEvent({ ...base, keyCode: 229, key: "Process" }, "keyDown")).toBeNull();
    expect(buildKeyEvent({ ...base, key: "v", metaKey: true }, "keyDown")).toBeNull();
  });

  it("respects the 32 character field limits", () => {
    const long = "x".repeat(40);
    const e = buildKeyEvent({ ...base, key: long, code: long, keyCode: 999 }, "keyDown");
    expect(e?.key).toBeUndefined();
    expect(e?.code).toBeUndefined();
    expect(e?.windowsVirtualKeyCode).toBeUndefined();
  });
});

describe("textToCharEvents", () => {
  it("emits one char event per character, newline as carriage return", () => {
    const events = textToCharEvents("a@+\n\u{1F600}");
    expect(events.map((e) => e.text)).toEqual(["a", "@", "+", "\r", "\u{1F600}"]);
    expect(events.every((e) => e.eventType === "char" && (e.text?.length ?? 0) <= 32)).toBe(true);
  });
});
