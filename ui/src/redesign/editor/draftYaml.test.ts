import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import {
  draftFileYaml,
  findingLineForFile,
  yamlFooterLabel,
  yamlPathForSelectedStage,
} from "./draftYaml";

function externalDraft(prompt: string): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-loop",
      model: "pi",
      stages: [{ id: "decide", uses: "./stages/decide.yaml" }],
    },
    stages: [
      {
        path: "stages/decide.yaml",
        body: { id: "decide", system_prompt: prompt },
      },
    ],
  };
}

describe("draftFileYaml", () => {
  it("serializes the in-memory pipeline document for the pipeline tab", () => {
    const text = draftFileYaml(
      externalDraft("hold"),
      "examples/feature-loop/feature-loop.pipeline.yaml",
      "examples/feature-loop/feature-loop.pipeline.yaml",
    );
    expect(text).toContain("id: feature-loop");
    expect(text).toContain("model: pi");
    expect(text).toContain("uses: ./stages/decide.yaml");
    expect(text).not.toContain("system_prompt");
  });

  it("serializes the stage body so a prompt edit shows before save", () => {
    const path = "stages/decide.yaml";
    const pipelinePath = "examples/feature-loop/feature-loop.pipeline.yaml";
    const before = draftFileYaml(externalDraft("hold the release"), path, pipelinePath);
    const after = draftFileYaml(externalDraft("ship the release"), path, pipelinePath);
    expect(before).toContain("hold the release");
    expect(after).toContain("ship the release");
    expect(after).not.toContain("hold the release");
  });

  it("indents nested stage fields by two spaces", () => {
    const draft: DraftPackagePayload = {
      pipeline: { id: "p", stages: [{ id: "decide", uses: "stages/decide.yaml" }] },
      stages: [
        {
          path: "stages/decide.yaml",
          body: {
            id: "decide",
            io: { input: { schema: { type: "object" } } },
          },
        },
      ],
    };
    const text = draftFileYaml(
      draft,
      "stages/decide.yaml",
      "p.pipeline.yaml",
    );
    expect(text).toContain("\n  input:\n    schema:\n");
  });

  it("matches a stage path with a leading dot-slash", () => {
    const text = draftFileYaml(
      externalDraft("hold"),
      "./stages/decide.yaml",
      "examples/feature-loop/feature-loop.pipeline.yaml",
    );
    expect(text).toContain("system_prompt:");
    expect(text).toContain("hold");
  });
});

describe("yaml footer and findings", () => {
  it("reports line count and spaces 2", () => {
    expect(yamlFooterLabel(1)).toBe("1 line · spaces 2");
    expect(yamlFooterLabel(4)).toBe("4 lines · spaces 2");
  });

  it("shows a finding line only when one is present", () => {
    expect(yamlFooterLabel(4, 12)).toBe("4 lines · spaces 2 · Ln 12");
    expect(
      findingLineForFile(
        { path: "stages/decide.yaml", message: "missing prompt" },
        "stages/decide.yaml",
      ),
    ).toBeUndefined();
    expect(
      findingLineForFile(
        { path: "examples/feature-loop/stages/decide.yaml", line: 3, message: "bad" },
        "stages/decide.yaml",
      ),
    ).toBe(3);
    expect(
      findingLineForFile(
        { path: "stages/other.yaml", line: 3 },
        "stages/decide.yaml",
      ),
    ).toBeUndefined();
  });
});

describe("yamlPathForSelectedStage", () => {
  it("returns the external stage file path", () => {
    expect(yamlPathForSelectedStage(externalDraft("hold"), "decide")).toBe(
      "stages/decide.yaml",
    );
  });

  it("returns null for an inline stage", () => {
    const draft: DraftPackagePayload = {
      pipeline: {
        id: "feature-loop",
        stages: [{ id: "decide", system_prompt: "hold" }],
      },
    };
    expect(yamlPathForSelectedStage(draft, "decide")).toBeNull();
  });
});
