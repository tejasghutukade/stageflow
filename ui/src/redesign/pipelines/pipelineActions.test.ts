import { describe, expect, it } from "vitest";
import {
  movePipelineSelection,
  pipelineEditorPath,
  pipelineStartRunPath,
  pipelineWorkshopPath,
  resolvePipelineSelection,
} from "./pipelineActions";

const keys = ["alpha", "beta"] as const;

describe("movePipelineSelection", () => {
  it("moves down from the first key and up from the second", () => {
    expect(movePipelineSelection(keys, "alpha", 1)).toBe("beta");
    expect(movePipelineSelection(keys, "beta", -1)).toBe("alpha");
  });

  it("selects the first row when nothing is selected", () => {
    expect(movePipelineSelection(keys, null, 1)).toBe("alpha");
    expect(movePipelineSelection(keys, null, -1)).toBe("alpha");
  });
});

describe("resolvePipelineSelection", () => {
  it("uses the first row until the operator chooses, and stays cleared after Escape", () => {
    expect(resolvePipelineSelection(undefined, keys)).toBe("alpha");
    expect(resolvePipelineSelection(null, keys)).toBeNull();
  });

  it("keeps the current row when sort still lists it", () => {
    expect(resolvePipelineSelection("beta", ["beta", "alpha"])).toBe("beta");
  });

  it("selects the first remaining row when search removes the pinned key", () => {
    expect(resolvePipelineSelection("gone", ["beta", "alpha"])).toBe("beta");
    expect(resolvePipelineSelection("gone", [])).toBeNull();
  });
});

describe("pipeline navigation paths", () => {
  it("includes project_root on the editor path", () => {
    const path = pipelineEditorPath({
      pipeline: { id: "fork-demo", project_root: "examples/app" },
    });
    expect(path).not.toBeNull();
    expect(decodeURIComponent(path!)).toContain("/pipelines/fork-demo");
    expect(decodeURIComponent(path!)).toContain("project_root=examples/app");
  });

  it("includes the task on the start-run path only when defaultTaskPath is set", () => {
    const catalogPath = "pipelines/demo.pipeline.yaml";
    const withTask = pipelineStartRunPath({
      catalogPath,
      defaultTaskPath: "pipelines/demo.task.yaml",
    });
    const withoutTask = pipelineStartRunPath({ catalogPath });
    expect(decodeURIComponent(withTask!)).toContain(catalogPath);
    expect(decodeURIComponent(withTask!)).toContain("pipelines/demo.task.yaml");
    expect(withTask).toContain("task=");
    expect(decodeURIComponent(withoutTask!)).toContain(catalogPath);
    expect(withoutTask).not.toContain("task=");
  });

  it("builds a workshop path from the catalog path and project_root", () => {
    const catalogPath = "pipelines/demo.pipeline.yaml";
    const path = pipelineWorkshopPath({
      catalogPath,
      pipeline: { project_root: "/Users/me/repo" },
    });
    expect(path).not.toBeNull();
    expect(path!.startsWith("/workshop")).toBe(true);
    expect(path!.startsWith("/pipelines")).toBe(false);
    expect(decodeURIComponent(path!)).toContain(catalogPath);
    expect(decodeURIComponent(path!)).toContain("project_root=/Users/me/repo");
  });

  it("does not produce a path when the row is missing", () => {
    expect(pipelineEditorPath(null)).toBeNull();
    expect(pipelineStartRunPath(undefined)).toBeNull();
    expect(pipelineWorkshopPath(null)).toBeNull();
  });
});
