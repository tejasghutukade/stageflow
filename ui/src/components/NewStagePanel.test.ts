import { describe, expect, it } from "vitest";
import { createStageGateKindsPayload } from "./NewStagePanel";

describe("NewStagePanel three-state gate_kinds", () => {
  it("omits the key for all-kinds compat, writes [] for no HITL, and allowlists selected kinds", () => {
    expect(createStageGateKindsPayload("all", [])).toEqual({});
    expect(createStageGateKindsPayload("none", ["confirm"])).toEqual({
      gate_kinds: [],
    });
    expect(createStageGateKindsPayload("allowlist", ["confirm"])).toEqual({
      gate_kinds: ["confirm"],
    });
  });
});
