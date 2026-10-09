import { describe, expect, it } from "vitest";
import type { StageGateKind } from "../api/types";
import { previewGateMeta } from "./NewRunPage";

describe("NewRun preview gate labels", () => {
  it.each<[StageGateKind[] | undefined, string]>([
    [undefined, "no gate"],
    [[], "no gate"],
    [["confirm"], "will ask you"],
  ])("previewGateMeta(%j) -> %s", (kinds, label) => {
    expect(previewGateMeta(kinds)).toBe(label);
  });
});
