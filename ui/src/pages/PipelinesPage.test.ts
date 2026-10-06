import { describe, expect, it } from "vitest";
import { gateLabel } from "./PipelinesPage";

describe("PipelinesPage gate labels", () => {
  it("treats omitted and empty as none (Option A)", () => {
    expect(gateLabel(undefined)).toBe("none");
    expect(gateLabel([])).toBe("none");
    expect(gateLabel(["confirm", "free_text"])).toBe("confirm · free_text");
  });
});
