import { describe, expect, it } from "vitest";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resolveCatalogContext } from "../src/config/resolveCatalogContext.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

async function seedManifestRepo(root: string): Promise<void> {
  await cp(manifestCatalog, root, { recursive: true });
}

describe("resolveCatalogContext", () => {
  it("returns missing when git repo has no manifest", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      clearFindProjectRootCacheForTests();
      const ctx = await resolveCatalogContext(root);
      expect(ctx.manifestStatus).toBe("missing");
      expect(ctx.projectRoot).toBe(realpathSync(root));
      expect(ctx.manifest).toBeNull();
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns not_git outside a git repository", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "sf-nogit-"));
    try {
      clearFindProjectRootCacheForTests();
      const ctx = await resolveCatalogContext(dir);
      expect(ctx.manifestStatus).toBe("not_git");
      expect(ctx.projectRoot).toBeNull();
    } finally {
      clearFindProjectRootCacheForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns invalid for bad manifest shape", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(path.join(root, "stageflow.yaml"), "version: 2\n");
      clearFindProjectRootCacheForTests();
      const ctx = await resolveCatalogContext(root);
      expect(ctx.manifestStatus).toBe("invalid");
      expect(ctx.issues.some((i) => i.code === "catalog.manifest_invalid")).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns ok with loaded manifest", async () => {
    const { root, nested, cleanup } = await initTempGitRepo();
    try {
      await seedManifestRepo(root);
      clearFindProjectRootCacheForTests();
      const ctx = await resolveCatalogContext(nested);
      expect(ctx.manifestStatus).toBe("ok");
      expect(ctx.projectRoot).toBe(realpathSync(root));
      expect(ctx.manifest?.manifest.catalog.pipelines).toContain("pipelines");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
