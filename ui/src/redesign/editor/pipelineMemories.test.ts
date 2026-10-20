import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { MemoriesPage } from "../memories/MemoriesPage";
import { readPipelineMemories, writePipelineMemories } from "./pipelineMemories";

const draft = (): DraftPackagePayload => ({
  pipeline: { id: "hiring", stages: [{ id: "search" }] },
});

describe("pipeline memories", () => {
  it("writes the id list onto the pipeline and omits it when empty", () => {
    const next = writePipelineMemories(draft(), ["candidate-pool", "notes"]);
    expect(next.pipeline.memories).toEqual(["candidate-pool", "notes"]);
    expect(readPipelineMemories(next)).toEqual(["candidate-pool", "notes"]);
    expect(next.pipeline.stages[0]).not.toHaveProperty("memories");
    expect(writePipelineMemories(next, []).pipeline.memories).toBeUndefined();
  });

  it("lists memories and shows an empty page", () => {
    const html = renderToStaticMarkup(createElement(MemoriesPage, { memoryId: "candidate-pool" }));
    expect(html).toContain("Memories");
    expect(html).toContain("Create memory");
    expect(html).toContain("Open a memory to read its page.");
    expect(html).toContain('data-testid="memories-page"');
  });
});