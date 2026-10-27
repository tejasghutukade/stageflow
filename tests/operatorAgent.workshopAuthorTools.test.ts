import { describe, expect, it } from "vitest";
import type { DraftPackage } from "../src/config/draftPackage.js";
import { emptyDraftPackage } from "../src/operatorAgent/draftContext.js";
import {
  buildCreatePipelineDraft,
  buildCreateStageDraft,
  buildEditPipelineDraft,
  buildEditStageDraft,
} from "../src/operatorAgent/profiles/workshopAuthorTools.js";

const channel = { connection: "ops", to: "C0123ABCD", operations: ["send"] };

const searchBody = {
  id: "search",
  system_prompt: "search",
  model: "kept-model",
};
const screenBody = {
  id: "screen",
  system_prompt: "screen",
  model: "kept-model",
};

function draft(
  pipeline: Partial<DraftPackage["pipeline"]> = {},
  stages?: DraftPackage["stages"],
): DraftPackage {
  return {
    pipeline: {
      id: "hiring",
      stages: [{ id: "search" }],
      model: "kept-model",
      ...pipeline,
    },
    ...(stages ? { stages } : {}),
  };
}

function draftWithBodies(): DraftPackage {
  return draft(
    {
      stages: [
        { id: "search", uses: "./search.yaml", entry: true },
        { id: "screen", uses: "./screen.yaml" },
      ],
    },
    [
      { path: "./search.yaml", body: searchBody },
      { path: "./screen.yaml", body: screenBody },
    ],
  );
}

function edited(base: DraftPackage, patch: Record<string, unknown>): DraftPackage {
  const result = buildEditPipelineDraft(base, { patch });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.nextDraft;
}

describe("buildEditPipelineDraft", () => {
  it("sets pipeline memories from a string array", () => {
    const next = edited(draft({ channels: [channel] }), {
      memories: ["candidate-pool", "notes"],
    });
    expect(next.pipeline.memories).toEqual(["candidate-pool", "notes"]);
    expect(next.pipeline.channels).toEqual([channel]);
    expect(next.pipeline.model).toBe("kept-model");
    expect(next.pipeline.id).toBe("hiring");
  });

  it("clears memories when the patch list is empty", () => {
    const source = draft({ memories: ["notes"], channels: [channel] });
    const next = edited(source, { memories: [] });
    expect(next.pipeline.memories).toBeUndefined();
    expect(next.pipeline).not.toHaveProperty("memories");
    expect(next.pipeline.channels).toEqual([channel]);
    expect(source.pipeline.memories).toEqual(["notes"]);
  });

  it("leaves memories untouched when the patch omits them", () => {
    const next = edited(draft({ memories: ["notes"], channels: [channel] }), {
      id: "renamed",
      description: "not a pipeline field",
    });
    expect(next.pipeline.id).toBe("renamed");
    expect(next.pipeline.memories).toEqual(["notes"]);
    expect(next.pipeline.channels).toEqual([channel]);
    expect(next.pipeline).not.toHaveProperty("description");
  });

  it("sets pipeline channels and drops an empty list", () => {
    const set = edited(draft({ memories: ["notes"] }), { channels: [channel] });
    expect(set.pipeline.channels).toEqual([channel]);
    expect(set.pipeline.memories).toEqual(["notes"]);

    const cleared = edited(set, { channels: [] });
    expect(cleared.pipeline.channels).toBeUndefined();
    expect(cleared.pipeline).not.toHaveProperty("channels");
    expect(cleared.pipeline.memories).toEqual(["notes"]);
  });

  it("reorders existing stages when each still has a matching body", () => {
    const source = draftWithBodies();
    const next = edited(source, {
      stages: [
        { id: "screen", uses: "./screen.yaml" },
        { id: "search", uses: "./search.yaml", entry: true },
      ],
    });
    expect(next.pipeline.stages.map((s) => s.id)).toEqual(["screen", "search"]);
    expect(next.stages).toEqual(source.stages);
  });

  it("refuses stages wiring that adds an unknown id without a body", () => {
    const source = draftWithBodies();
    const result = buildEditPipelineDraft(source, {
      patch: {
        stages: [
          { id: "search", uses: "./search.yaml", entry: true },
          { id: "screen", uses: "./screen.yaml" },
          { id: "offer", uses: "./offer.yaml" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refuse");
    expect(result.error).toMatch(/offer/);
    expect(result.error).toMatch(/create_stage|edit_stage/);
    expect(source.pipeline.stages.map((s) => s.id)).toEqual(["search", "screen"]);
  });

  it("refuses stages wiring that drops a body without create_stage/edit_stage", () => {
    const source = draftWithBodies();
    const result = buildEditPipelineDraft(source, {
      patch: {
        stages: [{ id: "search", uses: "./search.yaml", entry: true }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refuse");
    expect(result.error).toMatch(/screen/);
    expect(result.error).toMatch(/refused|create_stage|edit_stage/);
    expect(source.pipeline.stages).toHaveLength(2);
  });

  it("normalizes route on aliases when patching stages", () => {
    const source = draftWithBodies();
    const next = edited(source, {
      stages: [
        {
          id: "search",
          uses: "./search.yaml",
          entry: true,
          route: [{ to: "screen", on: "success" }],
        },
        { id: "screen", uses: "./screen.yaml" },
      ],
    });
    expect(next.pipeline.stages[0]?.route).toEqual([
      { to: "screen", on: "succeeded" },
    ]);
  });
});

describe("route on alias normalization in draft builders", () => {
  it("buildCreateStageDraft maps on: success to succeeded", () => {
    const result = buildCreateStageDraft(emptyDraftPackage("demo"), {
      id: "clarify",
      route: [{ to: "design-doc", on: "success" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.nextDraft.pipeline.stages[0]?.route).toEqual([
      { to: "design-doc", on: "succeeded" },
    ]);
  });

  it("buildEditStageDraft maps on: failure to failed", () => {
    const base = draftWithBodies();
    const result = buildEditStageDraft(base, {
      id: "search",
      route: [{ to: "screen", on: ["failure"] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.nextDraft.pipeline.stages[0]?.route).toEqual([
      { to: "screen", on: ["failed"] },
    ]);
  });

  it("buildCreatePipelineDraft normalizes stages route on aliases", () => {
    const result = buildCreatePipelineDraft(emptyDraftPackage(), {
      id: "demo",
      stages: [
        {
          id: "clarify",
          uses: "./clarify.yaml",
          entry: true,
          route: [{ to: "design-doc", on: ["success", "failure"] }],
        },
        { id: "design-doc", uses: "./design-doc.yaml" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.nextDraft.pipeline.stages[0]?.route).toEqual([
      { to: "design-doc", on: ["succeeded", "failed"] },
    ]);
  });

  it("buildCreatePipelineDraft fills io, route on, and entry for inline stages", () => {
    const result = buildCreatePipelineDraft(emptyDraftPackage(), {
      id: "demo",
      stages: [
        {
          id: "clarify",
          system_prompt: "Clarify the request",
          model: "test-model",
          route: [{ to: "design-doc", on: "success" }],
        },
        {
          id: "design-doc",
          system_prompt: "Write the design doc",
          model: "test-model",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const [first, second] = result.nextDraft.pipeline.stages;
    expect(first?.entry).toBe(true);
    expect(first?.io).toEqual({
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
    });
    expect(first?.route).toEqual([{ to: "design-doc", on: "succeeded" }]);
    expect(second?.entry).toBeUndefined();
    expect(second?.io).toEqual({
      input: { schema: { type: "object" } },
      output: { schema: { type: "object" } },
    });
  });
});
