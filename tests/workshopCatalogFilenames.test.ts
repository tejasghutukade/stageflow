import { describe, expect, it } from "vitest";
import {
  normalizeDraftCatalogFilenames,
  normalizePipelineCatalogFilename,
  normalizeTaskCatalogFilename,
} from "../src/config/workshopCatalogFilenames.js";

describe("workshopCatalogFilenames", () => {
  it("normalizes pipeline filenames to *.pipeline.yaml", () => {
    expect(normalizePipelineCatalogFilename("demo")).toBe("demo.pipeline.yaml");
    expect(normalizePipelineCatalogFilename("demo", "demo.yaml")).toBe(
      "demo.pipeline.yaml",
    );
    expect(normalizePipelineCatalogFilename("demo", "demo.pipeline.yaml")).toBe(
      "demo.pipeline.yaml",
    );
    expect(normalizePipelineCatalogFilename("other", "demo.pipeline.yaml")).toBe(
      "other.pipeline.yaml",
    );
  });

  it("normalizes task filenames to *.task.yaml", () => {
    expect(normalizeTaskCatalogFilename("ship")).toBe("ship.task.yaml");
    expect(normalizeTaskCatalogFilename("ship", "ship.yaml")).toBe("ship.task.yaml");
    expect(normalizeTaskCatalogFilename("ship", "add-csv-export.yaml")).toBe(
      "ship.task.yaml",
    );
    expect(normalizeTaskCatalogFilename("ship", "ship.task.yaml")).toBe(
      "ship.task.yaml",
    );
  });

  it("rewrites draft task and pipeline filenames together", () => {
    const { draft, pipelineFilename } = normalizeDraftCatalogFilenames(
      {
        pipeline: { id: "fanout-fanin-temp", stages: [] },
        task: { filename: "fanout-fanin-temp.yaml", body: { id: "fanout-fanin-temp" } },
      },
      "fanout-fanin-temp.yaml",
    );
    expect(pipelineFilename).toBe("fanout-fanin-temp.pipeline.yaml");
    expect(draft.task?.filename).toBe("fanout-fanin-temp.task.yaml");
  });
});
