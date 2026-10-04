import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearFindManifestRootCacheForTests,
  findManifestRoot,
} from "../src/project/findManifestRoot.js";

describe("findManifestRoot", () => {
  it("returns manifest root from nested subdirectory, no git involved", async () => {
    clearFindManifestRootCacheForTests();
    const root = await mkdtemp(path.join(tmpdir(), "sf-manifest-"));
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog: {}\n");
    try {
      expect(findManifestRoot(nested)).toBe(await realpath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when no stageflow.yaml exists in the parent chain", async () => {
    clearFindManifestRootCacheForTests();
    const dir = await mkdtemp(path.join(tmpdir(), "sf-nomanifest-"));
    try {
      expect(findManifestRoot(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caches results for the same startDir", async () => {
    clearFindManifestRootCacheForTests();
    const root = await mkdtemp(path.join(tmpdir(), "sf-manifest-cache-"));
    await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog: {}\n");
    try {
      const first = findManifestRoot(root);
      const second = findManifestRoot(root);
      expect(first).toBe(second);
      expect(first).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
