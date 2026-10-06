import { describe, expect, it } from "vitest";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import { listModelsFromManifest } from "../src/config/listModelsFromManifest.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const manifestCatalog = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/manifest-catalog",
);

describe("listModelsFromManifest", () => {
  it("collects models from manifest pipelines", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const outcome = await loadStageflowManifestOutcome(root);
      if (!outcome.ok) throw new Error("manifest");
      const models = await listModelsFromManifest({
        projectRoot: root,
        manifest: outcome.value,
        manifestStatus: "ok",
        issues: [],
      });
      expect(models).toContain("cursor/auto");
      expect(models).toContain("anthropic/claude-sonnet-4-5");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("returns baked defaults when manifest missing", async () => {
    const models = await listModelsFromManifest({
      projectRoot: null,
      manifest: null,
      manifestStatus: "missing",
      issues: [],
    });
    expect(models).toEqual([
      "anthropic/claude-sonnet-4-5",
      "cursor/auto",
      "cursor/composer-2-5",
    ]);
  });
});
