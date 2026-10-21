import { readFile } from "node:fs/promises";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import {
  ensureWorkspaceCatalog,
  resetWorkspaceProvisionForTests,
  workspaceCatalogPath,
} from "../src/project/workspaceCatalog.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

describe("workspaceCatalog", () => {
  const prevHome = process.env.STAGEFLOW_HOME;

  afterEach(async () => {
    if (prevHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = prevHome;
    }
    resetGlobalStageflowHomeForTests();
    resetWorkspaceProvisionForTests();
  });

  it("creates workspace/stageflow.yaml on an empty home", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-ws-home-"));
    try {
      const result = ensureWorkspaceCatalog(home);
      expect(result.ok).toBe(true);
      expect(result.path).toBe(path.join(home, "workspace"));
      const outcome = await loadStageflowManifestOutcome(result.path);
      expect(outcome.ok).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing manifest", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-ws-idem-"));
    try {
      ensureWorkspaceCatalog(home);
      const manifestPath = path.join(home, "workspace", "stageflow.yaml");
      await writeFile(manifestPath, "version: 1\ncustom: marker\n", "utf8");
      ensureWorkspaceCatalog(home);
      const text = await readFile(manifestPath, "utf8");
      expect(text).toContain("custom: marker");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resolves relative STAGEFLOW_HOME to one absolute workspace path", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "sf-ws-cwd-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(work);
      process.env.STAGEFLOW_HOME = "sf-rel";
      resetGlobalStageflowHomeForTests();
      const first = workspaceCatalogPath();
      process.chdir(tmpdir());
      expect(workspaceCatalogPath()).toBe(first);
    } finally {
      process.chdir(prevCwd);
      await rm(work, { recursive: true, force: true });
    }
  });
});
