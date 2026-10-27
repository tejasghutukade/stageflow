import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guidePipelineFile, guideWriteRoot, placeGuideWriteArgs } from "../src/guide/writeRoot.js";
import { workspaceCatalogPath } from "../src/project/workspaceCatalog.js";

describe("guideWriteRoot", () => {
  it("keeps a project that already has stageflow.yaml", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-guide-root-"));
    writeFileSync(path.join(root, "stageflow.yaml"), "version: 1\n");
    expect(guideWriteRoot(root)).toBe(root);
  });

  it("uses the workspace catalog when the project has no manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-guide-root-"));
    expect(guideWriteRoot(root)).toBe(workspaceCatalogPath());
  });
});

describe("placeGuideWriteArgs", () => {
  it("stores a new pipeline under pipelines/<id> and ignores the directory given", () => {
    expect(
      placeGuideWriteArgs("create_pipeline", {
        id: "policy-check",
        directory: "/Volumes/work/policy-samples",
        project_root: "/tmp/elsewhere",
      }),
    ).toEqual({ id: "policy-check", directory: "pipelines/policy-check" });
  });

  it("points a missing pipeline path at that same folder", () => {
    expect(
      placeGuideWriteArgs(
        "create_stage",
        { path: "catalog/policy-check/policy-check.pipeline.yaml", id: "review" },
        () => false,
      ).path,
    ).toBe(guidePipelineFile("policy-check"));
  });

  it("keeps a relative path when that pipeline file is already saved", () => {
    expect(
      placeGuideWriteArgs(
        "edit_pipeline",
        { path: "policy-check/policy-check.pipeline.yaml" },
        (rel) => rel === "policy-check/policy-check.pipeline.yaml",
      ).path,
    ).toBe("policy-check/policy-check.pipeline.yaml");
  });

  it("does not follow an absolute path even when a file is there", () => {
    const given = "/Volumes/work/policy-samples/policy-check.pipeline.yaml";
    expect(
      placeGuideWriteArgs("create_stage", { path: given }, () => true).path,
    ).toBe(guidePipelineFile("policy-check"));
  });
});
