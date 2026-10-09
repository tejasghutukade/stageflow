import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cursorBridgePrompt,
  cursorExtensionEntryInPackage,
  isCursorModelRef,
  readCursorApiKey,
  resolveAgentHomeCursorExtensionPath,
  resolveBundledCursorExtensionPath,
  resolveCursorExtensionPath,
  workshopCursorBridgeHint,
} from "../src/agent/cursorProvider.js";
import { findProviderSupport } from "../src/agent/providerSupport.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withDistinctRoots<T>(
  fn: (roots: { data: string; creds: string }) => Promise<T>,
): Promise<T> {
  const data = await mkdtemp(path.join(tmpdir(), "sf-cursor-data-"));
  const creds = await mkdtemp(path.join(tmpdir(), "sf-cursor-cred-"));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    STAGEFLOW_HOME: process.env.STAGEFLOW_HOME,
    credentialHome: process.env[CREDENTIAL_HOME_ENV],
    STAGEFLOW_AGENT_AUTH_PATH: process.env.STAGEFLOW_AGENT_AUTH_PATH,
    CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    CURSOR_API_KEY_FILE: process.env.CURSOR_API_KEY_FILE,
  };
  process.env.STAGEFLOW_HOME = data;
  process.env[CREDENTIAL_HOME_ENV] = creds;
  resetGlobalStageflowHomeForTests();
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY_FILE;
  try {
    return await fn({ data, creds });
  } finally {
    restoreEnv("HOME", prev.HOME);
    restoreEnv("USERPROFILE", prev.USERPROFILE);
    restoreEnv("STAGEFLOW_HOME", prev.STAGEFLOW_HOME);
    restoreEnv(CREDENTIAL_HOME_ENV, prev.credentialHome);
    restoreEnv("STAGEFLOW_AGENT_AUTH_PATH", prev.STAGEFLOW_AGENT_AUTH_PATH);
    restoreEnv("CURSOR_API_KEY", prev.CURSOR_API_KEY);
    restoreEnv("CURSOR_API_KEY_FILE", prev.CURSOR_API_KEY_FILE);
    resetGlobalStageflowHomeForTests();
    await rm(data, { recursive: true, force: true });
    await rm(creds, { recursive: true, force: true });
  }
}

describe("cursor provider support", () => {
  const prevExt = process.env.STAGEFLOW_CURSOR_EXTENSION;

  afterEach(() => {
    if (prevExt === undefined) {
      delete process.env.STAGEFLOW_CURSOR_EXTENSION;
    } else {
      process.env.STAGEFLOW_CURSOR_EXTENSION = prevExt;
    }
  });

  it("detects cursor model refs", () => {
    expect(isCursorModelRef("cursor/composer-2-5")).toBe(true);
    expect(isCursorModelRef("cursor/auto")).toBe(true);
    expect(isCursorModelRef("anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isCursorModelRef("composer-2-5")).toBe(false);
  });

  it("resolves STAGEFLOW_CURSOR_EXTENSION when the file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-cursor-ext-"));
    const entry = path.join(dir, "pi-cursor-sdk", "src", "index.ts");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "export {};\n");
    process.env.STAGEFLOW_CURSOR_EXTENSION = entry;

    const resolved = resolveCursorExtensionPath();
    expect(resolved).toBe(path.resolve(entry));
  });

  it("skips STAGEFLOW_CURSOR_EXTENSION when the file is missing", () => {
    process.env.STAGEFLOW_CURSOR_EXTENSION = path.join(
      tmpdir(),
      "sf-cursor-missing-does-not-exist.ts",
    );
    const resolved = resolveCursorExtensionPath();
    expect(resolved).not.toBe(process.env.STAGEFLOW_CURSOR_EXTENSION);
  });

  it("prefers dist/index.js over src/index.ts in a package root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cursor-pkg-"));
    await mkdir(path.join(root, "dist"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    const dist = path.join(root, "dist", "index.js");
    const src = path.join(root, "src", "index.ts");
    await writeFile(dist, "export {};\n");
    await writeFile(src, "export {};\n");
    expect(cursorExtensionEntryInPackage(root)).toBe(dist);
  });

  it("resolves pi-cursor-sdk from stageflow npm dependencies", () => {
    delete process.env.STAGEFLOW_CURSOR_EXTENSION;
    const bundled = resolveBundledCursorExtensionPath();
    expect(bundled).toBeDefined();
    expect(bundled).toMatch(/pi-cursor-sdk/);
    expect(resolveCursorExtensionPath()).toBe(bundled);
  });

  it("resolves the npm install from the process agent directory when the credential root differs", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      const attemptHome = path.join(data, "attempt");
      const entry = path.join(
        data,
        "agent",
        "npm",
        "node_modules",
        "pi-cursor-sdk",
        "dist",
        "index.js",
      );
      const decoy = path.join(
        creds,
        "agent",
        "npm",
        "node_modules",
        "pi-cursor-sdk",
        "dist",
        "index.js",
      );
      await mkdir(path.dirname(entry), { recursive: true });
      await mkdir(path.dirname(decoy), { recursive: true });
      await mkdir(attemptHome, { recursive: true });
      await writeFile(entry, "export {};\n");
      await writeFile(decoy, "export {};\n");

      process.env.HOME = attemptHome;
      process.env.USERPROFILE = attemptHome;
      process.env.STAGEFLOW_AGENT_AUTH_PATH = path.join(
        creds,
        "agent",
        "auth.json",
      );
      delete process.env.STAGEFLOW_CURSOR_EXTENSION;

      expect(resolveAgentHomeCursorExtensionPath()).toBe(entry);
    });
  });

  it("falls back to src/index.ts when dist is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cursor-src-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    const src = path.join(root, "src", "index.ts");
    await writeFile(src, "export {};\n");
    expect(cursorExtensionEntryInPackage(root)).toBe(src);
  });

  it("is registered as StageProviderSupport only for cursor models", () => {
    expect(findProviderSupport("cursor/composer-2-5")?.id).toBe("cursor");
    expect(findProviderSupport("anthropic/claude-sonnet-4-5")).toBeUndefined();
  });

  it("names workshop tools as pi__ MCP tools for cursor models", () => {
    const hint = workshopCursorBridgeHint(["create_stage", "read_draft"]);
    expect(hint).toContain("pi__create_stage");
    expect(hint).toContain("pi__read_draft");
    expect(cursorBridgePrompt("make a research stage", "cursor/auto", ["create_stage"])).toContain(
      "pi__create_stage",
    );
    expect(
      cursorBridgePrompt("make a research stage", "anthropic/claude-sonnet-4-5", ["create_stage"]),
    ).toBe("make a research stage");
  });
});

describe("readCursorApiKey credential root", () => {
  it("reads cursor-api-key from the credential root when CURSOR_API_KEY is unset", async () => {
    await withDistinctRoots(async ({ data, creds }) => {
      const credentialKey = path.join(creds, "agent", "cursor-api-key");
      const dataKey = path.join(data, "agent", "cursor-api-key");
      await mkdir(path.dirname(credentialKey), { recursive: true });
      await mkdir(path.dirname(dataKey), { recursive: true });
      await writeFile(credentialKey, "cursor-key-from-credential-root\n");
      await writeFile(dataKey, "cursor-key-from-data-dir\n");

      expect(readCursorApiKey()).toBe("cursor-key-from-credential-root");
    });
  });

  it("prefers CURSOR_API_KEY over the credential-root file", async () => {
    await withDistinctRoots(async ({ creds }) => {
      const credentialKey = path.join(creds, "agent", "cursor-api-key");
      await mkdir(path.dirname(credentialKey), { recursive: true });
      await writeFile(credentialKey, "cursor-key-from-credential-root\n");
      process.env.CURSOR_API_KEY = "cursor-key-from-env";

      expect(readCursorApiKey()).toBe("cursor-key-from-env");
    });
  });

  it("does not return a key file that exists only under the process data directory", async () => {
    await withDistinctRoots(async ({ data }) => {
      const dataKey = path.join(data, "agent", "cursor-api-key");
      await mkdir(path.dirname(dataKey), { recursive: true });
      await writeFile(dataKey, "cursor-key-from-data-dir\n");

      expect(readCursorApiKey()).toBeUndefined();
    });
  });
});
