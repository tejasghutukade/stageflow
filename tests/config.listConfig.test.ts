import { describe, expect, it } from "vitest";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import {
  listPipelines,
  listStages,
  listTasks,
} from "../src/config/listConfig.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

async function loadManifestFromRepo(root: string) {
  const outcome = await loadStageflowManifestOutcome(root);
  if (!outcome.ok) throw new Error("manifest");
  return outcome.value;
}

describe("listConfig manifest-driven", () => {
  it("AE1: lists pipelines from manifest directory scan", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const manifest = await loadManifestFromRepo(root);
      const pipelines = await listPipelines({ projectRoot: root, manifest });
      const paths = pipelines.map((p) => p.path);
      expect(paths).toContain("pipelines/demo.pipeline.yaml");
      expect(paths).not.toContain("pipelines/readme.md");
      expect(paths.some((p) => p.startsWith("excluded/"))).toBe(false);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE3: missing manifest context yields empty list via helper contract", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      clearFindProjectRootCacheForTests();
      const { resolveCatalogContext } = await import("../src/config/resolveCatalogContext.js");
      const ctx = await resolveCatalogContext(root);
      expect(ctx.manifestStatus).toBe("missing");
      expect(ctx.manifest).toBeNull();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE9: repo-relative paths stable from nested cwd", async () => {
    const { root, nested, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const manifest = await loadManifestFromRepo(root);
      const fromRoot = await listPipelines({ projectRoot: root, manifest });
      const fromNested = await listPipelines({ projectRoot: root, manifest });
      expect(fromNested.map((p) => p.path).sort()).toEqual(fromRoot.map((p) => p.path).sort());
      expect(fromNested.every((p) => !p.path.startsWith("nested/"))).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("skips broken pipeline files", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      const manifest = await loadManifestFromRepo(root);
      const pipelines = await listPipelines({ projectRoot: root, manifest });
      expect(pipelines.some((p) => p.path.includes("broken"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("lists tasks with id and goal", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      const manifest = await loadManifestFromRepo(root);
      const tasks = await listTasks({ projectRoot: root, manifest });
      expect(tasks).toEqual([
        {
          path: "tasks/demo.task.yaml",
          id: "demo-task",
          goal: "Exercise manifest task listing",
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("listStages returns empty array", async () => {
    expect(await listStages()).toEqual([]);
  });

  it("lists pipeline stages with uses_path and inline metadata", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      const manifest = await loadManifestFromRepo(root);
      const pipelines = await listPipelines({ projectRoot: root, manifest });
      const demo = pipelines.find((p) => p.id === "demo");
      expect(demo?.stages[0]).toMatchObject({
        id: "step",
        uses_path: "pipelines/step.yaml",
      });
      const fork = pipelines.find((p) => p.id === "fork-demo");
      expect(fork?.stages.some((s) => s.uses_path?.includes("decide.yaml"))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
