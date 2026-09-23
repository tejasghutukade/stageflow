import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
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

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

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

  it("accepts absolute unknown project_root as request-scoped root", () => {
    const base = mkdtempSync(path.join(tmpdir(), "sf-ephem-root-"));
    temps.push(base);
    mkdirSync(path.join(base, "pipelines"), { recursive: true });
    writeFileSync(path.join(base, "pipelines", "x.pipeline.yaml"), "id: x\n");

    const resolved = resolveCatalogRelativePath({
      inputPath: "pipelines/x.pipeline.yaml",
      projectRoot: base,
      roots,
      fieldName: "pipeline",
    });
    expect(resolved.root.kind).toBe("registered");
    expect(resolved.absolutePath).toBe(
      path.resolve(realpathSync(base), "pipelines", "x.pipeline.yaml"),
    );
  });

  it("still rejects unknown symbolic project_root", () => {
    expect(() =>
      resolveCatalogRelativePath({
        inputPath: "pipelines/x.pipeline.yaml",
        projectRoot: "unknown-seed",
        roots,
      }),
    ).toThrow(CatalogPathError);
    try {
      resolveCatalogRelativePath({
        inputPath: "pipelines/x.pipeline.yaml",
        projectRoot: "unknown-seed",
        roots,
      });
    } catch (err) {
      expect((err as CatalogPathError).code).toBe("unknown_project_root");
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

  it("realpaths both sides when cwd is a symlink", () => {
    const realBase = mkdtempSync(path.join(tmpdir(), "sf-rel-real-"));
    temps.push(realBase);
    const linkParent = mkdtempSync(path.join(tmpdir(), "sf-rel-link-parent-"));
    temps.push(linkParent);
    const linkCwd = path.join(linkParent, "proj-link");
    symlinkSync(realBase, linkCwd);
    writeFileSync(path.join(realBase, "x.pipeline.yaml"), "id: x\n");

    const out = relativizeLocalPathForNetwork(linkCwd, "x.pipeline.yaml");
    expect(out.path).toBe("x.pipeline.yaml");
    expect(out.project_root).toBe(realpathSync(linkCwd));
  });
});
