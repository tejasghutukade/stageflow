import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("packaging manifest", () => {
  it("lists publishable files and MIT license", () => {
    const pkg = readPkg();
    const files = pkg.files as string[];
    expect(files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(pkg.license).toBe("MIT");
  });

  it("prepublishOnly builds CLI, UI, and copies UI into dist", () => {
    const scripts = readPkg().scripts as Record<string, string>;
    const prepublishOnly = scripts.prepublishOnly ?? "";
    expect(prepublishOnly).toMatch(/\bbuild\b/);
    expect(prepublishOnly).toMatch(/\bui:build\b/);
    expect(prepublishOnly).toMatch(/\bcopy:ui-dist\b/);
  });

  it("bins point at dist/cli.js", () => {
    const bin = readPkg().bin as Record<string, string>;
    expect(bin.sf).toBe("./dist/cli.js");
    expect(bin.stageflow).toBe("./dist/cli.js");
  });

  it("repository URL points at tejasghutukade/stageflow", () => {
    const repository = readPkg().repository as { url?: string } | string | undefined;
    const url =
      typeof repository === "string" ? repository : (repository?.url ?? "");
    expect(url).toMatch(/tejasghutukade\/stageflow/);
  });
});
