import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CredentialMaterialisationError,
  cleanupCredentialsDir,
  materialiseCredentialFile,
  materialiseSecretBytes,
} from "../src/runtime/credentialMaterialisation.js";
import {
  loadSecretRegistry,
  resolveStageSecrets,
  SecretUnavailableError,
} from "../src/runtime/stageSecrets.js";

describe("credentialMaterialisation", () => {
  it("copies with mode 0400 and rejects symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cred-"));
    try {
      const source = path.join(root, "token.txt");
      writeFileSync(source, "secret-value", { mode: 0o600 });
      const destDir = path.join(root, "credentials", "tok");
      const copied = materialiseCredentialFile({
        sourcePath: source,
        destDir,
        allowedRoot: root,
      });
      expect(readFileSync(copied.destPath, "utf8")).toBe("secret-value");
      const mode = readFileSync(copied.destPath).length;
      expect(mode).toBeGreaterThan(0);
      expect(existsSync(copied.destPath)).toBe(true);

      const link = path.join(root, "link");
      symlinkSync(source, link);
      expect(() =>
        materialiseCredentialFile({
          sourcePath: link,
          destDir: path.join(root, "credentials", "bad"),
          allowedRoot: root,
        }),
      ).toThrow(CredentialMaterialisationError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleanup removes credentials dir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cred-clean-"));
    try {
      const destDir = path.join(root, "credentials", "x");
      materialiseSecretBytes({
        contents: "abc",
        destDir,
        destBasename: "token",
      });
      expect(existsSync(path.join(root, "credentials"))).toBe(true);
      cleanupCredentialsDir(root);
      expect(existsSync(path.join(root, "credentials"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveStageSecrets", () => {
  it("helper grant sets GIT_ASKPASS without GITHUB_TOKEN in env", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sec-resolve-"));
    try {
      const home = path.join(root, "home");
      mkdirSync(home, { recursive: true });
      const registry = loadSecretRegistry({
        GITHUB_TOKEN: "ghp_test_token_value_xx",
      });
      const result = resolveStageSecrets({
        decls: [{ name: "GITHUB_TOKEN" }],
        registry,
        hostEnv: { GITHUB_TOKEN: "ghp_test_token_value_xx" },
        attemptDir: root,
        home,
      });
      expect(result.grants.env.GIT_ASKPASS).toBeTruthy();
      expect(result.grants.env.STAGEFLOW_GIT_ASKPASS_TOKEN_FILE).toBeTruthy();
      expect(result.grants.env.GITHUB_TOKEN).toBeUndefined();
      expect(
        readFileSync(result.grants.env.STAGEFLOW_GIT_ASKPASS_TOKEN_FILE!, "utf8"),
      ).toBe("ghp_test_token_value_xx");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("as: env injects value and warns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sec-env-"));
    try {
      const registry = loadSecretRegistry({
        GITHUB_TOKEN: "ghp_as_env_token_xx",
      });
      const result = resolveStageSecrets({
        decls: [{ name: "GITHUB_TOKEN", as: "env" }],
        registry,
        hostEnv: { GITHUB_TOKEN: "ghp_as_env_token_xx" },
        attemptDir: root,
      });
      expect(result.grants.env.GITHUB_TOKEN).toBe("ghp_as_env_token_xx");
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("empty Host value → secret_unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sec-unavail-"));
    try {
      const registry = loadSecretRegistry({});
      expect(() =>
        resolveStageSecrets({
          decls: [{ name: "GITHUB_TOKEN" }],
          registry,
          hostEnv: {},
          attemptDir: root,
        }),
      ).toThrow(SecretUnavailableError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("file-kind secrets register contents into knownValues", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sec-file-"));
    try {
      const home = path.join(root, "home");
      const secretsDir = path.join(home, "secrets");
      mkdirSync(secretsDir, { recursive: true });
      const source = path.join(secretsDir, "npm-token");
      const contents = "npm-file-secret-value-xx";
      writeFileSync(source, contents, { mode: 0o600 });
      writeFileSync(
        path.join(secretsDir, "file-credentials.json"),
        JSON.stringify({
          NPM_TOKEN: { source, pointerVar: "NPM_TOKEN_FILE" },
        }),
      );
      const registry = loadSecretRegistry({}, home);
      const result = resolveStageSecrets({
        decls: [{ name: "NPM_TOKEN" }],
        registry,
        hostEnv: {},
        attemptDir: root,
        home,
      });
      expect(result.grants.env.NPM_TOKEN_FILE).toBeTruthy();
      expect(result.knownValues).toEqual([{ name: "NPM_TOKEN", value: contents }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
