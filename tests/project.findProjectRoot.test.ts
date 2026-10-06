import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearFindProjectRootCacheForTests,
  findProjectRoot,
} from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

describe("findProjectRoot", () => {
  it("returns git root from nested subdirectory", async () => {
    clearFindProjectRootCacheForTests();
    const { root, nested, cleanup } = await initTempGitRepo();
    try {
      expect(findProjectRoot(nested)).toBe(await realpath(root));
    } finally {
      await cleanup();
    }
  });

  it("returns null outside a git repository", async () => {
    clearFindProjectRootCacheForTests();
    const dir = await mkdtemp(path.join(tmpdir(), "sf-nogit-"));
    try {
      expect(findProjectRoot(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("walks parent chain for synthetic .git directory", async () => {
    clearFindProjectRootCacheForTests();
    const root = await mkdtemp(path.join(tmpdir(), "sf-synth-git-"));
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    try {
      expect(findProjectRoot(nested)).toBe(await realpath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caches results for the same startDir", async () => {
    clearFindProjectRootCacheForTests();
    const { nested, cleanup } = await initTempGitRepo();
    try {
      const first = findProjectRoot(nested);
      const second = findProjectRoot(nested);
      expect(first).toBe(second);
      expect(first).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});
