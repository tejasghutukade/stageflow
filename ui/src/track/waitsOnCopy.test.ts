import { describe, expect, it } from "vitest";
import { waitsOnCopy } from "./waitsOnCopy";

describe("waitsOnCopy", () => {
  it("joins blocker labels with waits on prefix", () => {
    expect(waitsOnCopy(["review"], (id) => id)).toBe("waits on review");
  });

  it("lists every blocker in order", () => {
    expect(waitsOnCopy(["review", "test"], (id) => id)).toBe(
      "waits on review, test",
    );
  });

  it("falls back when blocked_by is empty", () => {
    expect(waitsOnCopy([], () => "x")).toBe("waits on upstream");
  });
});
