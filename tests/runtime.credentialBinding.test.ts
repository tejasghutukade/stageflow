import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureSfOwnedAuthStore,
  isUsableAuthFile,
  resolveCredentialBinding,
  sfOwnedAuthPath,
} from "../src/runtime/credentialBinding.js";
import {
  readCredentialSourceFromFile,
  writeCredentialSourceToContext,
  writeCredentialSourceToFile,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { resolveProjectContext } from "../src/project/resolveProjectContext.js";
import { initTempGitRepo, withIsolatedHome } from "./helpers/projectContext.js";

describe("resolveCredentialBinding", () => {
  it("ensures SF-owned auth store under global home", async () => {
    await withIsolatedHome(async (home) => {
      const authPath = ensureSfOwnedAuthStore();
      expect(authPath).toBe(sfOwnedAuthPath());
      expect(authPath.startsWith(path.join(home, ".stageflow"))).toBe(true);
      expect(isUsableAuthFile(authPath)).toBe(false);
    });
  });

  it("provisional pi_home when unset and Pi-home auth is usable", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(piHome), { recursive: true });
      await writeFile(
        piHome,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );

      const binding = resolveCredentialBinding(home, { piHomeAuthPath: piHome });
      expect(binding).toEqual({
        source: "pi_home",
        authPath: piHome,
        provisional: true,
      });
      expect(readCredentialSourceFromFile(home)).toBeUndefined();
    });
  });

  it("provisional sf_owned when unset and Pi-home is missing", async () => {
    await withIsolatedHome(async (home) => {
      const missingPi = path.join(home, "missing-pi", "auth.json");
      const binding = resolveCredentialBinding(home, {
        piHomeAuthPath: missingPi,
      });
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(true);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
    });
  });

  it("persisted sf_owned wins even when Pi-home is usable", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(piHome), { recursive: true });
      await writeFile(
        piHome,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );
      writeCredentialSourceToFile(home, "sf_owned");

      const binding = resolveCredentialBinding(home, { piHomeAuthPath: piHome });
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(false);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
    });
  });

  it("persisted pi_home returns Pi-home path", async () => {
    await withIsolatedHome(async (home) => {
      const piHome = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(piHome), { recursive: true });
      await writeFile(piHome, "{}\n");
      writeCredentialSourceToFile(home, "pi_home");

      const binding = resolveCredentialBinding(home, { piHomeAuthPath: piHome });
      expect(binding).toEqual({
        source: "pi_home",
        authPath: piHome,
        provisional: false,
      });
    });
  });

  it("AE4: sf_owned auth is not under git-root project store", async () => {
    await withIsolatedHome(async (home) => {
      const { nested, cleanup } = await initTempGitRepo();
      try {
        writeCredentialSourceToContext(resolveProjectContext(nested), "sf_owned");
        const binding = resolveCredentialBinding(nested);
        expect(binding.authPath).toBe(path.join(home, ".stageflow", "agent", "auth.json"));
        expect(binding.authPath.startsWith(storeRootFor(nested))).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});
