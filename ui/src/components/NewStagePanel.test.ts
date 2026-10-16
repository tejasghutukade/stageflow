import { describe, expect, it } from "vitest";
import {
  createStageGateKindsPayload,
  validateFields,
} from "./NewStagePanel";

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

describe("NewStagePanel validation", () => {
  it("requires an id and a system prompt but not a model", () => {
    expect(validateFields({ id: "hello", system_prompt: "Say hello." })).toEqual({});
    expect(validateFields({ id: "", system_prompt: "  " })).toEqual({
      id: "Stage id is required",
      system_prompt: "System prompt is required",
    });
  });
});
