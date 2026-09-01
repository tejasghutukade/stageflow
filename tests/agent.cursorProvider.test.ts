import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cursorExtensionEntryInPackage,
  isCursorModelRef,
  resolveCursorExtensionPath,
} from "../src/agent/cursorProvider.js";
import { findProviderSupport } from "../src/agent/providerSupport.js";

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
});
