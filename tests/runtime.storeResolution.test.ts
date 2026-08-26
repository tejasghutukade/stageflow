import { describe, expect, it } from "vitest";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { resolveProjectContext } from "../src/project/resolveProjectContext.js";
import {
  ensureSfOwnedAuthStore,
  sfOwnedAuthPath,
} from "../src/runtime/credentialBinding.js";
import {
  readCredentialSourceFromContext,
  writeCredentialSourceToContext,
  writeFactorySettingsForContext,
} from "../src/runtime/settingsFile.js";
import { globalSettingsFilePath } from "../src/runtime/settingsFile.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

describe("runtime store resolution", () => {
  it("AE1: createRunStore from subdirectory context writes to git-root store", async () => {
    await withIsolatedHome(async () => {
      const { root, nested, cleanup } = await initTempGitRepo();
      try {
        const ctx = resolveProjectContext(nested);
        const store = createRunStore({ rootDir: ctx.projectRoot });
        const created = await store.createRun({
          pipelineId: "p1",
          taskYaml: "id: t1\n",
          taskId: "t1",
        });
        expect(created.runId.length).toBeGreaterThan(0);
        await access(path.join(storeRootFor(root), "state.db"));
        await expect(
          access(path.join(storeRootFor(nested), "state.db")),
        ).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });

  it("AE3: non-git context stores under HOME/.stageflow", async () => {
    await withIsolatedHome(async (home) => {
      const outside = path.join(home, "workspace");
      await mkdir(outside, { recursive: true });
      const ctx = resolveProjectContext(outside);
      createRunStore({ rootDir: ctx.projectRoot });
      await access(path.join(home, ".stageflow", "state.db"));
    });
  });

  it("AE4: sf_owned auth is global even inside git repo", async () => {
    await withIsolatedHome(async (home) => {
      const { nested, cleanup } = await initTempGitRepo();
      try {
        resolveProjectContext(nested);
        const authPath = ensureSfOwnedAuthStore();
        expect(authPath).toBe(sfOwnedAuthPath());
        expect(authPath).toBe(path.join(home, ".stageflow", "agent", "auth.json"));
        await expect(
          access(path.join(storeRootFor(nested), "agent", "auth.json")),
        ).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });

  it("AE5: project credentialSource overrides global", async () => {
    await withIsolatedHome(async (home) => {
      const { root, nested, cleanup } = await initTempGitRepo();
      try {
        const globalCtx = resolveProjectContext(home);
        writeFactorySettingsForContext(globalCtx, {
          credentialSource: "sf_owned",
        });
        const projectCtx = resolveProjectContext(nested);
        writeCredentialSourceToContext(projectCtx, "pi_home");
        expect(readCredentialSourceFromContext(projectCtx)).toBe("pi_home");
        expect(globalSettingsFilePath()).toBe(
          path.join(home, ".stageflow", "settings.json"),
        );
        const projectSettings = path.join(
          storeRootFor(root),
          "settings.json",
        );
        await access(projectSettings);
      } finally {
        await cleanup();
      }
    });
  });

  it("AE7: legacy .software-factory migrates at git root", async () => {
    await withIsolatedHome(async () => {
      const { root, nested, cleanup } = await initTempGitRepo();
      try {
        const legacy = path.join(root, ".software-factory");
        await mkdir(legacy, { recursive: true });
        await writeFile(
          path.join(legacy, "settings.json"),
          `${JSON.stringify({ maxConcurrent: 2 }, null, 2)}\n`,
        );
        const ctx = resolveProjectContext(nested);
        createRunStore({ rootDir: ctx.projectRoot });
        await access(path.join(storeRootFor(root), "state.db"));
        await access(path.join(storeRootFor(root), "settings.json"));
        await expect(access(legacy)).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });

});
