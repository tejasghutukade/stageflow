import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);

describe("runtime pipeline-owned smoke", () => {
  it("loaded pipeline stages align with dag nodes", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(loaded.stages.length).toBe(loaded.dag.nodes.length);
    expect(loaded.pipeline.stages.length).toBe(loaded.dag.nodes.length);
    const topoIds = loaded.dag.nodes.map((node) => node.id);
    expect(new Set(topoIds).size).toBe(topoIds.length);
    for (const stageId of loaded.pipeline.stages) {
      expect(loaded.dag.nodes.some((node) => node.id === stageId)).toBe(true);
    }
  });
});
