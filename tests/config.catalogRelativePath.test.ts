import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CatalogPathError,
  resolveCatalogRelativePath,
  relativizeLocalPathForNetwork,
} from "../src/config/catalogRelativePath.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";

const roots: CatalogRoot[] = [
  {
    project_root: "/proj/a",
    path: "/proj/a",
    kind: "boot",
    read_only: false,
  },
  {
    project_root: "examples",
    path: "/opt/stageflow/examples",
    kind: "seeded",
    read_only: true,
  },
];

describe("resolveCatalogRelativePath", () => {
  it("refuses absolute paths with registered roots listed", () => {
    expect(() =>
      resolveCatalogRelativePath({
        inputPath: "/Users/me/x.pipeline.yaml",
        roots,
        fieldName: "pipeline",
      }),
    ).toThrow(CatalogPathError);
    try {
      resolveCatalogRelativePath({
        inputPath: "/Users/me/x.pipeline.yaml",
        projectRoot: "examples",
        roots,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogPathError);
      expect((err as CatalogPathError).code).toBe("absolute_path_not_allowed");
      expect((err as CatalogPathError).registered_roots).toContain("examples");
    }
  });

  it("resolves catalog-relative under seeded root", () => {
    const resolved = resolveCatalogRelativePath({
      inputPath: "pipelines/demo.pipeline.yaml",
      projectRoot: "examples",
      roots,
    });
    expect(resolved.root.project_root).toBe("examples");
    expect(resolved.absolutePath).toBe(
      path.resolve("/opt/stageflow/examples", "pipelines/demo.pipeline.yaml"),
    );
  });

  it("refuses .. escape", () => {
    expect(() =>
      resolveCatalogRelativePath({
        inputPath: "../outside.yaml",
        projectRoot: "/proj/a",
        roots,
      }),
    ).toThrow(/path_outside_project_root|escapes/);
    try {
      resolveCatalogRelativePath({
        inputPath: "../outside.yaml",
        projectRoot: "/proj/a",
        roots,
      });
    } catch (err) {
      expect((err as CatalogPathError).code).toBe("path_outside_project_root");
    }
  });
});

describe("relativizeLocalPathForNetwork", () => {
  it("rewrites absolute under cwd to relative + project_root", () => {
    const cwd = "/proj";
    const out = relativizeLocalPathForNetwork(cwd, "/proj/pipelines/x.pipeline.yaml");
    expect(out.path).toBe("pipelines/x.pipeline.yaml");
    expect(out.project_root).toBe(path.resolve(cwd));
  });
});
