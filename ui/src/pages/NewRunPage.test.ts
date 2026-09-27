import { describe, expect, it } from "vitest";
import { previewGateMeta } from "./NewRunPage";

describe("NewRun preview gate labels", () => {
  it("labels omitted gate_kinds as no gate (Option A)", () => {
    expect(previewGateMeta(undefined)).toBe("no gate");
  });

  it("labels empty and allowlist distinctly", () => {
    expect(previewGateMeta([])).toBe("no gate");
    expect(previewGateMeta(["confirm"])).toBe("will ask you");
  });
});
