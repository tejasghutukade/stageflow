import { describe, expect, it } from "vitest";
import {
  createStageGateKindsPayload,
  MODEL_INHERIT,
  MODEL_OTHER,
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
  it("validateFields does not error when model is empty for inherit", () => {
    expect(
      validateFields({
        id: "hello",
        model: "",
        system_prompt: "Say hello.",
        useDropdown: true,
        modelSelect: MODEL_INHERIT,
      }),
    ).toEqual({});
  });

  it("validateFields errors when Other is selected and custom model is blank", () => {
    expect(
      validateFields({
        id: "hello",
        model: "",
        system_prompt: "Say hello.",
        useDropdown: true,
        modelSelect: MODEL_OTHER,
      }),
    ).toEqual({
      model: "Model is required when Other is selected.",
    });

    expect(
      validateFields({
        id: "hello",
        model: "   ",
        system_prompt: "Say hello.",
        useDropdown: true,
        modelSelect: MODEL_OTHER,
      }),
    ).toEqual({
      model: "Model is required when Other is selected.",
    });
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
