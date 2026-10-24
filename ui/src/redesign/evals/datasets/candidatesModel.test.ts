import { describe, expect, it } from "vitest";
import { addRunsLabel, toggleSelection } from "./candidatesModel";

describe("candidates model", () => {
  it("toggles ids", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });
  it("labels the button", () => {
    expect(addRunsLabel(0)).toBe("Add cases");
    expect(addRunsLabel(1)).toBe("Add 1 case");
    expect(addRunsLabel(3)).toBe("Add 3 cases");
  });
});
