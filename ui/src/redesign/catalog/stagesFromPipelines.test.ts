import { describe, expect, it } from "vitest";
import { stagesFromPipelines } from "./stagesFromPipelines";
import type { PipelineListing } from "../../api";

describe("stagesFromPipelines", () => {
  it("merges stages referenced by multiple pipelines", () => {
    const pipelines: PipelineListing[] = [
      {
        path: "pipelines/a.pipeline.yaml",
        id: "pipe-a",
        stages: [
          { id: "lint", uses_path: "stages/lint.yaml", gate_kinds: ["confirm"] },
          { id: "ship" },
        ],
      },
      {
        path: "pipelines/b.pipeline.yaml",
        id: "pipe-b",
        stages: [{ id: "lint" }, { id: "docs" }],
      },
    ];
    const rows = stagesFromPipelines(pipelines);
    expect(rows.map((r) => r.id)).toEqual(["docs", "lint", "ship"]);
    const lint = rows.find((r) => r.id === "lint");
    expect(lint?.used_by_pipeline_ids.sort()).toEqual(["pipe-a", "pipe-b"]);
    expect(lint?.rowKey).toBe(":lint");
    expect(lint?.uses_path).toBe("stages/lint.yaml");
    expect(lint?.gate_kinds).toEqual(["confirm"]);
  });

  it("returns empty when no pipeline stages", () => {
    expect(stagesFromPipelines([])).toEqual([]);
  });
});
