import { describe, expect, it } from "vitest";
import { gateLabel } from "./PipelinesPage";

describe("PipelinesPage gate labels", () => {
  it.each([
    [undefined, "none"],
    [[], "none"],
    [["confirm", "free_text"], "confirm · free_text"],
  ])("gateLabel(%j) -> %s", (kinds, label) => {
    expect(gateLabel(kinds)).toBe(label);
  });
});
