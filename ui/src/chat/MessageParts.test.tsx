import { describe, expect, it } from "vitest";
import { uiPartsFromMetadata } from "./MessageParts";

describe("uiPartsFromMetadata", () => {
  it("returns the same empty array every time so store selectors do not loop", () => {
    expect(uiPartsFromMetadata(undefined)).toBe(uiPartsFromMetadata({}));
    expect(uiPartsFromMetadata({ custom: {} })).toBe(uiPartsFromMetadata(null));
    expect(uiPartsFromMetadata({ custom: { uiParts: "nope" } })).toHaveLength(0);
  });

  it("returns the stored array itself", () => {
    const uiParts = [{ v: 1, kind: "card" }];
    expect(uiPartsFromMetadata({ custom: { uiParts } })).toBe(uiParts);
  });
});
