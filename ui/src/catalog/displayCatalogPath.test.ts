import { describe, expect, it } from "vitest";
import * as catalogPaths from "./displayCatalogPath";

describe("ui displayCatalogPath", () => {
  it("matches pipeline runs by stored path", () => {
    expect(
      catalogPaths.matchPipelineRun(
        {
          pipeline_id: "legacy",
          pipeline_path: "/repo/pipelines/demo.pipeline.yaml",
          project_root: "/repo",
        },
        { id: "demo", path: "pipelines/demo.pipeline.yaml" },
      ),
    ).toBe(true);
  });

  it("formats run subtitles from locators", () => {
    expect(
      catalogPaths.runLocatorSubtitle({
        pipeline_id: "demo",
        pipeline_path: "/repo/pipelines/demo.pipeline.yaml",
        task_path: "/repo/tasks/demo.task.yaml",
        project_root: "/repo",
      }),
    ).toBe("pipelines/demo.pipeline.yaml · tasks/demo.task.yaml");

    expect(
      catalogPaths.runTaskLabel({
        pipeline_id: "demo",
        task_path: "/repo/tasks/demo.task.yaml",
        project_root: "/repo",
      }),
    ).toBe("tasks/demo.task.yaml");
  });

  it("falls back to ids for legacy runs", () => {
    expect(catalogPaths.displayCatalogPath("/any/path", undefined)).toBe("path");
    expect(
      catalogPaths.runLocatorSubtitle({ pipeline_id: "demo", task_id: "hello" }),
    ).toBe("demo · hello");
  });
});
