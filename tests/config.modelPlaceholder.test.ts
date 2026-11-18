import { describe, expect, it } from "vitest";
import { isModelPlaceholder } from "../src/cli/initTemplates.js";
import { findingsForModelPlaceholders } from "../src/config/modelPlaceholder.js";
import type { LoadedPipeline } from "../src/types/pipeline.js";

describe("model placeholder", () => {
  it("detects CHANGE_ME models", () => {
    expect(isModelPlaceholder("CHANGE_ME/<provider-model>")).toBe(true);
    expect(isModelPlaceholder("CHANGE_ME/openrouter-model")).toBe(true);
    expect(isModelPlaceholder("openrouter/auto")).toBe(false);
  });

  it("emits catalog findings for pipeline and stage placeholders", () => {
    const loaded = {
      pipeline: { id: "hello", stages: [{ id: "hello" }] },
      stages: [{ id: "hello", model: "CHANGE_ME/<provider-model>", system_prompt: "hi" }],
      stageSources: {},
    } as unknown as LoadedPipeline;
    const findings = findingsForModelPlaceholders("/proj", "/proj/pipelines/hello.pipeline.yaml", loaded);
    expect(findings.some((f) => f.code === "catalog.model_placeholder")).toBe(true);
  });
});