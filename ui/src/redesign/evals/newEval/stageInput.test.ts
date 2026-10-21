import { describe, expect, it } from "vitest";
import { stageInputFields } from "./stageInput";

describe("stageInputFields", () => {
  it("reads an inline stage", () => {
    const yaml = `id: p
stages:
  - id: critique
    io:
      input:
        schema:
          type: object
          required: [draft]
          properties:
            draft: { type: string }
            n: { type: integer }
`;
    expect(stageInputFields({ stageId: "critique", pipelineYaml: yaml })).toEqual([
      { name: "draft", required: true, type: "string" },
      { name: "n", required: false, type: "integer" },
    ]);
  });
  it("prefers the stage file and resolves $ref against pipeline schemas", () => {
    const pipeline = `id: p
schemas:
  story:
    type: object
    required: [title]
    properties:
      title: { type: string }
stages:
  - id: plan
    uses: stages/plan.yaml
`;
    const stage = `system_prompt: x
io:
  input:
    schema: { $ref: '#/schemas/story' }
`;
    expect(stageInputFields({ stageId: "plan", pipelineYaml: pipeline, stageYaml: stage })).toEqual([
      { name: "title", required: true, type: "string" },
    ]);
  });
  it("returns null when unreadable", () => {
    expect(stageInputFields({ stageId: "x", pipelineYaml: "id: p\nstages: []" })).toBeNull();
    expect(stageInputFields({ stageId: "x", stageYaml: ": : :" })).toBeNull();
  });
});
