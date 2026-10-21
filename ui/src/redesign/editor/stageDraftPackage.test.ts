import { describe, expect, it } from "vitest";
import { buildStageDraftPackage } from "./stageDraftPackage";

const STAGE_YAML = `id: decide
system_prompt: hold the release
model: pi
`;

describe("buildStageDraftPackage", () => {
  it("builds an external-uses draft with stages[] artifact from stage path + YAML", () => {
    const { draft, listing, stageId } = buildStageDraftPackage(
      "examples/feature-loop/stages/decide.yaml",
      STAGE_YAML,
    );

    expect(stageId).toBe("decide");
    expect(draft.pipeline.stages).toEqual([
      { id: "decide", uses: "./examples/feature-loop/stages/decide.yaml" },
    ]);
    expect(draft.stages).toEqual([
      {
        path: "examples/feature-loop/stages/decide.yaml",
        body: {
          id: "decide",
          system_prompt: "hold the release",
          model: "pi",
        },
      },
    ]);
    expect(listing.id).toBe("decide");
    expect(listing.stages).toEqual([
      { id: "decide", uses_path: "examples/feature-loop/stages/decide.yaml" },
    ]);
  });

  it("falls back to filename when body has no id", () => {
    const { stageId, draft } = buildStageDraftPackage(
      "stages/clarify.yaml",
      "system_prompt: ask\n",
    );
    expect(stageId).toBe("clarify");
    expect(draft.pipeline.stages[0]).toMatchObject({ id: "clarify" });
    expect(draft.stages?.[0]?.body.id).toBe("clarify");
  });

  it("attaches project_root to the synthetic listing when provided", () => {
    const { listing } = buildStageDraftPackage(
      "stages/decide.yaml",
      STAGE_YAML,
      "/tmp/project",
    );
    expect(listing.project_root).toBe("/tmp/project");
  });

  it("rejects non-mapping YAML roots", () => {
    expect(() => buildStageDraftPackage("stages/x.yaml", "- just a list\n")).toThrow(
      /mapping/i,
    );
  });
});
