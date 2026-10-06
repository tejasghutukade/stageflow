import { describe, expect, it } from "vitest";
import path from "node:path";
import { normalizeCatalogPath } from "../src/runstore/normalizeCatalogPath.js";

describe("normalizeCatalogPath", () => {
  it("resolves relative paths to absolute", () => {
    const cwd = path.resolve("/tmp/project");
    const result = normalizeCatalogPath(path.join(cwd, "./foo.yaml"));
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve(cwd, "foo.yaml"));
  });

  it("collapses dot segments", () => {
    const base = path.resolve("/tmp/project/sub");
    const result = normalizeCatalogPath(path.join(base, ".././foo.yaml"));
    expect(result).toBe(path.resolve("/tmp/project/foo.yaml"));
  });
});
