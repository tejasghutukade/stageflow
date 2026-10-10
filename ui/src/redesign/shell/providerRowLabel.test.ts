import { describe, expect, it } from "vitest";
import { providerRowLabel } from "./providerRowLabel";

describe("providerRowLabel", () => {
  it("joins up to two providers", () => {
    expect(providerRowLabel(["anthropic", "openai"])).toBe("anthropic · openai");
  });

  it("truncates with +N suffix", () => {
    expect(providerRowLabel(["a", "b", "c", "d"])).toBe("a · b · +2");
  });
});
