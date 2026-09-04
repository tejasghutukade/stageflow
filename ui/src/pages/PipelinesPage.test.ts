import { describe, expect, it } from "vitest";
import { gateLabel } from "./PipelinesPage";

describe("PipelinesPage gate labels", () => {
  it("distinguishes omitted, empty, and allowlist", () => {
    expect(gateLabel(undefined)).toBe("all kinds");
    expect(gateLabel([])).toBe("none");
    expect(gateLabel(["confirm", "free_text"])).toBe("confirm · free_text");
  });
});
