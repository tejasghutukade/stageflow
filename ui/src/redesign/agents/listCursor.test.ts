import { describe, expect, it } from "vitest";
import { clampCursor, isCursorKey, moveCursor, shouldHandleCursorKey } from "./listCursor";

describe("moveCursor", () => {
  it("starts on the first row and stops at both ends", () => {
    expect(moveCursor(-1, "ArrowDown", 3)).toBe(0);
    expect(moveCursor(-1, "ArrowUp", 3)).toBe(0);
    expect(moveCursor(1, "ArrowDown", 3)).toBe(2);
    expect(moveCursor(2, "ArrowDown", 3)).toBe(2);
    expect(moveCursor(0, "ArrowUp", 3)).toBe(0);
  });
  it("does nothing on an empty list", () => {
    expect(moveCursor(-1, "ArrowDown", 0)).toBe(-1);
    expect(moveCursor(2, "ArrowUp", 0)).toBe(-1);
  });
});

describe("clampCursor", () => {
  it("keeps the cursor on a row that still exists", () => {
    expect(clampCursor(4, 2)).toBe(1);
    expect(clampCursor(0, 2)).toBe(0);
    expect(clampCursor(-1, 2)).toBe(-1);
    expect(clampCursor(3, 0)).toBe(-1);
  });
});

describe("shouldHandleCursorKey", () => {
  it("ignores typing and controls, but not the row links", () => {
    expect(isCursorKey("ArrowDown")).toBe(true);
    expect(isCursorKey("Enter")).toBe(false);
    expect(shouldHandleCursorKey({ tagName: "INPUT" })).toBe(false);
    expect(shouldHandleCursorKey({ tagName: "BUTTON" })).toBe(false);
    expect(shouldHandleCursorKey({ tagName: "A", dataset: {} })).toBe(false);
    expect(shouldHandleCursorKey({ tagName: "A", dataset: { listRow: "" } })).toBe(true);
    expect(shouldHandleCursorKey({ tagName: "DIV" })).toBe(true);
    expect(shouldHandleCursorKey({ tagName: "DIV", isContentEditable: true })).toBe(false);
  });
});
