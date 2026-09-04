import { describe, expect, it } from "vitest";
import { isNearBottom } from "./TranscriptStream";

describe("isNearBottom", () => {
  it("is true when scrolled all the way to the bottom", () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }),
    ).toBe(true);
  });

  it("is true within the near-bottom threshold", () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 870, clientHeight: 100 }),
    ).toBe(true);
  });

  it("is false once scrolled up past the threshold", () => {
    expect(
      isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 }),
    ).toBe(false);
  });

  it("is true when content is shorter than the viewport", () => {
    expect(
      isNearBottom({ scrollHeight: 50, scrollTop: 0, clientHeight: 100 }),
    ).toBe(true);
  });
});
