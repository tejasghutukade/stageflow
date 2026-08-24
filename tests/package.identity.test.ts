import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/package-meta.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("package identity", () => {
  it("names the npm package, PACKAGE_NAME, and UI workspace Stageflow", () => {
    const pkg = readJson("package.json");
    const ui = readJson("ui/package.json");
    expect(pkg.name).toBe("stageflow");
    expect(PACKAGE_NAME).toBe("stageflow");
    expect(ui.name).toBe("@stageflow/ui");
  });

  it("keeps sf as the short bin and uses stageflow as the long bin", () => {
    const pkg = readJson("package.json");
    const bin = pkg.bin as Record<string, string>;
    expect(bin.sf).toBe("./dist/cli.js");
    expect(bin.stageflow).toBe("./dist/cli.js");
    expect(bin["software-factory"]).toBeUndefined();
  });
});
