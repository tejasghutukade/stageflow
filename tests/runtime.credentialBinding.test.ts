import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureSfOwnedAuthStore,
  isUsableAuthFile,
  resolveCredentialBinding,
  sfOwnedAuthPath,
} from "../src/runtime/credentialBinding.js";
import {
  readCredentialSourceFromFile,
  writeCredentialSourceToFile,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";

describe("resolveCredentialBinding", () => {
  it("ensures SF-owned auth store under the project store root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bind-ensure-"));
    const authPath = ensureSfOwnedAuthStore(root);
    expect(authPath).toBe(sfOwnedAuthPath(root));
    expect(authPath.startsWith(storeRootFor(root))).toBe(true);
    expect(isUsableAuthFile(authPath)).toBe(false);
  });

  it("provisional pi_home when unset and Pi-home auth is usable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bind-pihome-"));
    const piHome = path.join(root, "fake-pi-home", "auth.json");
    await mkdir(path.dirname(piHome), { recursive: true });
    await writeFile(
      piHome,
      JSON.stringify({ openai: { type: "api_key", key: "x" } }),
    );

    const binding = resolveCredentialBinding(root, { piHomeAuthPath: piHome });
    expect(binding).toEqual({
      source: "pi_home",
      authPath: piHome,
      provisional: true,
    });
    expect(readCredentialSourceFromFile(root)).toBeUndefined();
  });

  it("provisional sf_owned when unset and Pi-home is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bind-sf-"));
    const missingPi = path.join(root, "missing-pi", "auth.json");
    const binding = resolveCredentialBinding(root, {
      piHomeAuthPath: missingPi,
    });
    expect(binding.source).toBe("sf_owned");
    expect(binding.provisional).toBe(true);
    expect(binding.authPath).toBe(sfOwnedAuthPath(root));
  });

  it("persisted sf_owned wins even when Pi-home is usable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bind-persist-sf-"));
    const piHome = path.join(root, "fake-pi-home", "auth.json");
    await mkdir(path.dirname(piHome), { recursive: true });
    await writeFile(
      piHome,
      JSON.stringify({ openai: { type: "api_key", key: "x" } }),
    );
    writeCredentialSourceToFile(root, "sf_owned");

    const binding = resolveCredentialBinding(root, { piHomeAuthPath: piHome });
    expect(binding.source).toBe("sf_owned");
    expect(binding.provisional).toBe(false);
    expect(binding.authPath).toBe(sfOwnedAuthPath(root));
  });

  it("persisted pi_home returns Pi-home path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bind-persist-pi-"));
    const piHome = path.join(root, "fake-pi-home", "auth.json");
    await mkdir(path.dirname(piHome), { recursive: true });
    await writeFile(piHome, "{}\n");
    writeCredentialSourceToFile(root, "pi_home");

    const binding = resolveCredentialBinding(root, { piHomeAuthPath: piHome });
    expect(binding).toEqual({
      source: "pi_home",
      authPath: piHome,
      provisional: false,
    });
  });
});
