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

  it("provisional sf_owned when unset even if a legacy Pi-home file exists elsewhere", async () => {
    await withIsolatedHome(async (home) => {
      const legacyPi = path.join(home, "fake-pi-home", "auth.json");
      await mkdir(path.dirname(legacyPi), { recursive: true });
      await writeFile(
        legacyPi,
        JSON.stringify({ openai: { type: "api_key", key: "x" } }),
      );

      const binding = resolveCredentialBinding(home);
      expect(binding).toEqual({
        source: "sf_owned",
        authPath: sfOwnedAuthPath(),
        provisional: true,
      });
      expect(readCredentialSourceFromFile(home)).toBeUndefined();
    });
  });

  it("provisional sf_owned when unset", async () => {
    await withIsolatedHome(async (home) => {
      const binding = resolveCredentialBinding(home);
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

      const binding = resolveCredentialBinding(home);
      expect(binding.source).toBe("sf_owned");
      expect(binding.provisional).toBe(false);
      expect(binding.authPath).toBe(sfOwnedAuthPath());
    });
  });

  it("legacy pi_home on disk normalizes to sf_owned binding", async () => {
    await withIsolatedHome(async (home) => {
      await mkdir(storeRootFor(home), { recursive: true });
      await writeFile(
        path.join(storeRootFor(home), "settings.json"),
        `${JSON.stringify({ credentialSource: "pi_home" }, null, 2)}\n`,
      );

      const binding = resolveCredentialBinding(home);
      expect(binding).toEqual({
        source: "sf_owned",
        authPath: sfOwnedAuthPath(),
        provisional: false,
      });
      expect(readCredentialSourceFromFile(home)).toBe("sf_owned");
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
