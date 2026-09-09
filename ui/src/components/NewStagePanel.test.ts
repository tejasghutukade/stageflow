import { describe, expect, it } from "vitest";
import {
  createStageGateKindsPayload,
  MODEL_INHERIT,
  resolveCreateStageModel,
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

describe("NewStagePanel optional model", () => {
  it("validateFields does not error when model is empty", () => {
    expect(
      validateFields({
        id: "hello",
        model: "",
        system_prompt: "Say hello.",
      }),
    ).toEqual({});
  });

  it("resolveCreateStageModel returns empty for inherit sentinel", () => {
    expect(
      resolveCreateStageModel({
        useDropdown: true,
        modelSelect: MODEL_INHERIT,
        customModel: "",
        plainModel: "",
      }),
    ).toBe("");
  });

  it("resolveCreateStageModel returns empty plain model so payload can omit model", () => {
    expect(
      resolveCreateStageModel({
        useDropdown: false,
        modelSelect: MODEL_INHERIT,
        customModel: "",
        plainModel: "   ",
      }),
    ).toBe("");
  });
});
