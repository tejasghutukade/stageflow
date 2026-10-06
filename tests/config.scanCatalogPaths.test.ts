import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import { isExcluded, scanCatalogPaths } from "../src/config/scanCatalogPaths.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

async function loadManifest() {
  const outcome = await loadStageflowManifestOutcome(manifestCatalog);
  if (!outcome.ok) throw new Error("expected manifest");
  return outcome.value;
}

describe("scanCatalogPaths", () => {
  it("collects matching files from declared directories", async () => {
    const manifest = await loadManifest();
    const paths = await scanCatalogPaths(manifest, "pipeline");
    const relPaths = paths.map((p) => path.relative(manifestCatalog, p).replace(/\\/g, "/"));
    expect(relPaths).toContain("pipelines/demo.pipeline.yaml");
    expect(relPaths).toContain("pipeline-owned/fork-uses/fork-demo.pipeline.yaml");
    expect(relPaths).not.toContain("pipelines/readme.md");
  });

  it("includes explicit file entries when present", async () => {
    const manifest = await loadManifest();
    const paths = await scanCatalogPaths(manifest, "task");
    const relPaths = paths.map((p) => path.relative(manifestCatalog, p).replace(/\\/g, "/"));
    expect(relPaths).toEqual(["tasks/demo.task.yaml"]);
  });

  it("excludes paths under exclude prefixes", async () => {
    expect(isExcluded("excluded/hidden.pipeline.yaml", ["excluded"])).toBe(true);
    expect(isExcluded("pipelines/demo.pipeline.yaml", ["excluded"])).toBe(false);
    const manifest = await loadManifest();
    const paths = await scanCatalogPaths(manifest, "pipeline");
    const relPaths = paths.map((p) => path.relative(manifestCatalog, p).replace(/\\/g, "/"));
    expect(relPaths.some((p) => p.startsWith("excluded/"))).toBe(false);
  });

  it("dedupes overlapping entries", async () => {
    const manifest = await loadManifest();
    const paths = await scanCatalogPaths(manifest, "pipeline");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("matches custom patterns", async () => {
    const outcome = await loadStageflowManifestOutcome(manifestCatalog);
    if (!outcome.ok) throw new Error("manifest");
    const custom = {
      ...outcome.value,
      manifest: {
        version: 1 as const,
        catalog: {
          pipelines: ["pipelines"],
          tasks: ["tasks"],
          patterns: { pipeline: "*.yaml", task: "*.yaml" },
        },
      },
      patterns: { pipeline: "*.yaml", task: "*.yaml" },
    };
    const paths = await scanCatalogPaths(custom, "pipeline");
    const basenames = paths.map((p) => path.basename(p));
    expect(basenames).toContain("step.yaml");
  });
});
