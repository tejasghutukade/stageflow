import { describe, expect, it } from "vitest";
import { previewGateMeta } from "./NewRunPage";

describe("NewRun preview gate labels", () => {
  it("does not label omitted gate_kinds as no gate", () => {
    expect(previewGateMeta(undefined)).toBe("all kinds");
    expect(previewGateMeta(undefined)).not.toBe("no gate");
  });

  it("labels empty, omitted, and allowlist distinctly", () => {
    expect(previewGateMeta([])).toBe("no gate");
    expect(previewGateMeta(["confirm"])).toBe("will ask you");
    expect(previewGateMeta(undefined)).toBe("all kinds");
  });
});
