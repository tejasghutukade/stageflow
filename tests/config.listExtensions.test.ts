import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listExtensions } from "../src/config/listExtensions.js";

async function writeExtension(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await writeFile(
    filePath,
    "export default function () {}\n",
    "utf8",
  );
  return filePath;
}

describe("listExtensions", () => {
  const previousHome = process.env.HOME;
  let cwd: string;
  let agentDir: string;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-ext-home-"));
    cwd = await mkdtemp(path.join(tmpdir(), "sf-ext-cwd-"));
    agentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;
    await mkdir(agentDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("lists user and project extension files from injected dirs", async () => {
    const userPath = await writeExtension(
      path.join(agentDir, "extensions"),
      "fixture-user.ts",
    );
    const projectPath = await writeExtension(
      path.join(cwd, ".pi", "extensions"),
      "fixture-project.ts",
    );

    const catalog = await listExtensions({ cwd, agentDir });
    const byName = Object.fromEntries(
      catalog.extensions.map((ext) => [ext.name, ext]),
    );

    expect(byName["fixture-user"]).toMatchObject({
      name: "fixture-user",
      path: userPath,
      scope: "user",
      source: "auto",
      origin: "top-level",
      enabled: true,
    });
    expect(byName["fixture-project"]).toMatchObject({
      name: "fixture-project",
      path: projectPath,
      scope: "project",
      source: "auto",
      origin: "top-level",
      enabled: true,
    });
    expect(catalog.extensions.map((e) => e.name)).toEqual(
      [...catalog.extensions.map((e) => e.name)].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it("lists a configured local-path package that exists on disk", async () => {
    const pkgDir = path.join(home, "local-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "sf-fixture-local-pkg",
        pi: { extensions: ["hello.ts"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(pkgDir, "hello.ts"),
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [pkgDir] }),
      "utf8",
    );

    const catalog = await listExtensions({ cwd, agentDir });
    expect(catalog.packages).toEqual([
      {
        source: pkgDir,
        scope: "user",
        filtered: false,
        installedPath: pkgDir,
      },
    ]);
    expect(
      catalog.extensions.some(
        (ext) =>
          ext.path === path.join(pkgDir, "hello.ts") &&
          ext.origin === "package" &&
          ext.scope === "user",
      ),
    ).toBe(true);
  });

  it("lists a missing npm package without installing it", async () => {
    const missing = "npm:definitely-not-installed-sf-fixture";
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [missing] }),
      "utf8",
    );

    const catalog = await listExtensions({ cwd, agentDir });
    expect(catalog.packages).toEqual([
      {
        source: missing,
        scope: "user",
        filtered: false,
      },
    ]);
    expect(existsSync(path.join(agentDir, "npm"))).toBe(false);
    expect(existsSync(path.join(cwd, ".pi", "npm"))).toBe(false);
  });

  it("omits auto-discovered files disabled by settings overrides", async () => {
    await writeExtension(path.join(agentDir, "extensions"), "fixture-ok.ts");
    const disabledPath = await writeExtension(
      path.join(agentDir, "extensions"),
      "fixture-disabled.ts",
    );
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: ["-extensions/fixture-disabled.ts"],
      }),
      "utf8",
    );

    const catalog = await listExtensions({ cwd, agentDir });
    expect(catalog.extensions.map((e) => e.name)).toContain("fixture-ok");
    expect(catalog.extensions.map((e) => e.path)).not.toContain(disabledPath);
  });

  it("does not import DefaultResourceLoader", async () => {
    const srcPath = fileURLToPath(
      new URL("../src/config/listExtensions.ts", import.meta.url),
    );
    const src = await readFile(srcPath, "utf8");
    expect(src).not.toMatch(/DefaultResourceLoader/);
  });
});
