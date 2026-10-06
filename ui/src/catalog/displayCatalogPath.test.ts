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

  it("returns one label when pipeline and task labels match", () => {
    expect(
      catalogPaths.runLocatorSubtitle({
        pipeline_id: "demo",
        task_id: "demo",
      }),
    ).toBe("demo");
    expect(
      catalogPaths.runLocatorSubtitle({
        pipeline_id: "demo",
        pipeline_path: "/repo/demo.yaml",
        task_path: "/repo/demo.yaml",
        project_root: "/repo",
      }),
    ).toBe("demo.yaml");
  });

  it("returns the pipeline label when the task label is missing", () => {
    expect(catalogPaths.runLocatorSubtitle({ pipeline_id: "demo" })).toBe("demo");
  });

  it("formats binding locators by kind (U8)", () => {
    expect(catalogPaths.bindingLocatorText({ kind: "unbound" })).toBe("unbound");
    expect(
      catalogPaths.bindingLocatorText({
        kind: "checkout",
        checkout_root: "/tmp/work/my-project",
      }),
    ).toBe("checkout · my-project");
    expect(
      catalogPaths.bindingLocatorTitle({
        kind: "checkout",
        checkout_root: "/tmp/work/my-project",
      }),
    ).toBe("/tmp/work/my-project");

    expect(
      catalogPaths.bindingLocatorText({
        kind: "repository",
        repository: "acme/api",
        ref: "main",
        resolved_sha: "abcdef0123456789",
        run_branch: "stageflow/run-1",
        checkout_root: "/home/.stageflow/worktrees/run-1",
      }),
    ).toBe("repository · acme/api · main · abcdef0 · stageflow/run-1");
    expect(
      catalogPaths.bindingLocatorTitle({
        kind: "repository",
        resolved_sha: "abcdef0123456789",
        checkout_root: "/home/.stageflow/worktrees/run-1",
      }),
    ).toBe("abcdef0123456789\n/home/.stageflow/worktrees/run-1");

    expect(
      catalogPaths.bindingListCompactText({
        kind: "repository",
        repository: "acme/api",
        ref: "main",
        resolved_sha: "abcdef0123456789",
      }),
    ).toBe("repository · acme/api · main · abcdef0");
    expect(catalogPaths.bindingListCompactText({ kind: "checkout" })).toBe(
      "checkout",
    );
  });
});
