import { describe, expect, it } from "vitest";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ensureGlobalHome, globalStageflowHome } from "../src/project/globalHome.js";
import { resolveProjectContext } from "../src/project/resolveProjectContext.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

describe("resolveProjectContext", () => {
  it("uses homedir store outside git (AE3)", async () => {
    await withIsolatedHome(async (home) => {
      const outside = path.join(home, "workspace");
      await mkdir(outside, { recursive: true });
      const ctx = resolveProjectContext(outside);
      expect(ctx.isGitProject).toBe(false);
      expect(ctx.projectRoot).toBe(home);
      expect(ctx.globalHome).toBe(path.join(home, ".stageflow"));
      expect(ctx.invocationCwd).toBe(path.resolve(outside));
    });
  });

  it("resolves git root from nested invocation cwd", async () => {
    await withIsolatedHome(async () => {
      const { root, nested, cleanup } = await initTempGitRepo();
      try {
        const ctx = resolveProjectContext(nested);
        expect(ctx.isGitProject).toBe(true);
        expect(ctx.projectRoot).toBe(await realpath(root));
        expect(ctx.invocationCwd).toBe(path.resolve(nested));
        expect(storeRootFor(ctx.projectRoot)).toBe(
          path.join(await realpath(root), ".stageflow"),
        );
      } finally {
        await cleanup();
      }
    });
  });

  it("ensureGlobalHome creates agent subdirectory", async () => {
    await withIsolatedHome(async (home) => {
      const globalHome = ensureGlobalHome();
      expect(globalHome).toBe(globalStageflowHome());
      await access(path.join(home, ".stageflow", "agent"));
    });
  });
});
