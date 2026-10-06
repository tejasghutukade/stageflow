import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("Clone Chain clone_cap: 1 catalog load", () => {
  it("loads a Clone Chain with clone_cap 1 and compiles minItems/maxItems onto the Clone Array", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-chain-cap-1"), {
      cwd: fixtures,
    });
    expect(loaded.pipeline.stages).toEqual(["emit-items", "handle-item", "gather"]);

    const emitter = loaded.dag.nodes.find((node) => node.id === "emit-items");
    expect(emitter).toMatchObject({
      clone_cap: 1,
      clone_mode: "parallel",
      clone_array_field: "items",
      entry: true,
    });

    const emitterStage = loaded.stages.find((stage) => stage.id === "emit-items");
    const items = (
      emitterStage?.payload_schema as { properties?: Record<string, unknown> }
    )?.properties?.items as { minItems?: number; maxItems?: number };
    expect(items).toMatchObject({ type: "array", minItems: 1, maxItems: 1 });
  });
});
