import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INVALID_CREDENTIAL_SOURCE_MESSAGE,
  parseCredentialSource,
  readCredentialSourceFromFile,
  readFactorySettings,
  readMaxConcurrentFromFile,
  writeCredentialSourceToFile,
  writeFactorySettings,
  writeMaxConcurrentToFile,
} from "../src/runtime/settingsFile.js";
import { storeRootFor } from "../src/runstore/paths.js";

describe("settingsFile credentialSource", () => {
  it("writes sf_owned and reads it back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-cs-"));
    writeCredentialSourceToFile(root, "sf_owned");
    expect(readCredentialSourceFromFile(root)).toBe("sf_owned");
  });

  it("preserves maxConcurrent when writing credentialSource", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-preserve-mc-"));
    writeMaxConcurrentToFile(root, 4);
    writeCredentialSourceToFile(root, "pi_home");
    expect(readMaxConcurrentFromFile(root)).toBe(4);
    expect(readCredentialSourceFromFile(root)).toBe("pi_home");
  });

  it("preserves credentialSource when writing maxConcurrent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-preserve-cs-"));
    writeCredentialSourceToFile(root, "sf_owned");
    writeMaxConcurrentToFile(root, 2);
    expect(readCredentialSourceFromFile(root)).toBe("sf_owned");
    expect(readMaxConcurrentFromFile(root)).toBe(2);
  });

  it("treats invalid credentialSource on disk as unset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-invalid-"));
    await mkdir(storeRootFor(root), { recursive: true });
    await writeFile(
      path.join(storeRootFor(root), "settings.json"),
      `${JSON.stringify({ credentialSource: "ambient_env", maxConcurrent: 3 }, null, 2)}\n`,
    );
    const settings = readFactorySettings(root);
    expect(settings.credentialSource).toBeUndefined();
    expect(settings.maxConcurrent).toBe(3);
    expect(parseCredentialSource("nope")).toBeUndefined();
  });

  it("rejects invalid credentialSource on write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-reject-"));
    expect(() =>
      writeFactorySettings(root, {
        credentialSource: "ambient_env" as "pi_home",
      }),
    ).toThrow(INVALID_CREDENTIAL_SOURCE_MESSAGE);
  });

  it("does not store secrets in settings.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-settings-no-secrets-"));
    writeFactorySettings(root, {
      maxConcurrent: 1,
      credentialSource: "sf_owned",
    });
    const raw = await readFile(
      path.join(storeRootFor(root), "settings.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({
      maxConcurrent: 1,
      credentialSource: "sf_owned",
    });
    expect(raw).not.toMatch(/api[_-]?key|sk-|token/i);
  });
});
