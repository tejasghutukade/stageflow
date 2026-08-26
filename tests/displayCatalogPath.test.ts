import { describe, expect, it } from "vitest";
import {
  displayCatalogPath,
  matchPipelineRun,
  normalizeCatalogSlashes,
} from "../src/catalog/displayCatalogPath.js";

describe("displayCatalogPath", () => {
  it("returns repo-relative path when under project root", () => {
    expect(
      displayCatalogPath("/repo/pipelines/demo.pipeline.yaml", "/repo"),
    ).toBe("pipelines/demo.pipeline.yaml");
  });

  it("falls back to basename without project root", () => {
    expect(displayCatalogPath("/abs/pipelines/demo.pipeline.yaml")).toBe(
      "demo.pipeline.yaml",
    );
  });

  it("normalizes slashes", () => {
    expect(normalizeCatalogSlashes("a\\b/c")).toBe("a/b/c");
  });
});

describe("matchPipelineRun", () => {
  it("matches by pipeline id", () => {
    expect(
      matchPipelineRun({ pipeline_id: "demo" }, { id: "demo", path: "pipelines/demo.pipeline.yaml" }),
    ).toBe(true);
  });

  it("matches ad-hoc run by stored path", () => {
    expect(
      matchPipelineRun(
        {
          pipeline_id: "other",
          pipeline_path: "/repo/pipelines/demo.pipeline.yaml",
          project_root: "/repo",
        },
        { id: "demo", path: "pipelines/demo.pipeline.yaml" },
      ),
    ).toBe(true);
  });

  it("does not match unrelated runs", () => {
    expect(
      matchPipelineRun({ pipeline_id: "alpha" }, { id: "beta", path: "pipelines/beta.pipeline.yaml" }),
    ).toBe(false);
  });
});
