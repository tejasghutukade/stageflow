import { describe, expect, it } from "vitest";
import { previewGateMeta } from "./NewRunPage";

describe("NewRun preview gate labels", () => {
  it.each([
    [undefined, "no gate"],
    [[], "no gate"],
    [["confirm"], "will ask you"],
  ])("previewGateMeta(%j) -> %s", (kinds, label) => {
    expect(previewGateMeta(kinds)).toBe(label);
  });
});
