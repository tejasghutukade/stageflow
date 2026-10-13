import { describe, expect, it } from "vitest";
import { nextGateIndex, wrapGateIndex } from "./inboxViews";

describe("inbox selection helpers", () => {
  it("wraps gate index", () => {
    expect(wrapGateIndex(-1, 3)).toBe(2);
    expect(wrapGateIndex(3, 3)).toBe(0);
  });

  it("steps next and previous", () => {
    expect(nextGateIndex(0, 3, 1)).toBe(1);
    expect(nextGateIndex(0, 3, -1)).toBe(2);
  });
});
