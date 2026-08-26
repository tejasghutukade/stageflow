import { describe, expect, it } from "vitest";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resolveStageflowContext } from "../src/project/resolveStageflowContext.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

async function seedManifestRepo(root: string): Promise<void> {
  await cp(manifestCatalog, root, { recursive: true });
}

describe("resolveStageflowContext", () => {
  it("resolves git root and store from nested invocation cwd", async () => {
    await withIsolatedHome(async () => {
      const { root, nested, cleanup } = await initTempGitRepo();
      try {
        clearFindProjectRootCacheForTests();
        const ctx = await resolveStageflowContext(nested);
        expect(ctx.isGitProject).toBe(true);
        expect(ctx.projectRoot).toBe(realpathSync(root));
        expect(ctx.invocationCwd).toBe(path.resolve(nested));
        expect(storeRootFor(ctx.projectRoot)).toBe(
          path.join(realpathSync(root), ".stageflow"),
        );
      } finally {
        clearFindProjectRootCacheForTests();
        await cleanup();
      }
    });
  });

  it("uses homedir project root outside git with not_git manifest status", async () => {
    await withIsolatedHome(async (home) => {
      const outside = path.join(home, "workspace");
      await mkdir(outside, { recursive: true });
      clearFindProjectRootCacheForTests();
      const ctx = await resolveStageflowContext(outside);
      expect(ctx.isGitProject).toBe(false);
      expect(ctx.projectRoot).toBe(home);
      expect(ctx.manifestStatus).toBe("not_git");
      expect(ctx.manifest).toBeNull();
      expect(ctx.manifestIssues).toEqual([]);
    });
  });

  it("returns missing when git repo has no manifest", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      clearFindProjectRootCacheForTests();
      const ctx = await resolveStageflowContext(root);
      expect(ctx.manifestStatus).toBe("missing");
      expect(ctx.projectRoot).toBe(realpathSync(root));
      expect(ctx.manifest).toBeNull();
      expect(ctx.isGitProject).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns invalid for bad manifest shape", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(path.join(root, "stageflow.yaml"), "version: 2\n");
      clearFindProjectRootCacheForTests();
      const ctx = await resolveStageflowContext(root);
      expect(ctx.manifestStatus).toBe("invalid");
      expect(ctx.manifestIssues.some((i) => i.code === "catalog.manifest_invalid")).toBe(
        true,
      );
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
      const ctx = await resolveStageflowContext(nested);
      expect(ctx.manifestStatus).toBe("ok");
      expect(ctx.projectRoot).toBe(realpathSync(root));
      expect(ctx.manifest?.manifest.catalog.pipelines).toContain("pipelines");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
