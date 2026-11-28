import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storedProjectMatches } from "../src/artifacts/projectIdentity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("storedProjectMatches", () => {
  it("matches a symbolic id or an absolute path", () => {
    expect(storedProjectMatches("workspace", { id: "workspace", path: "/a/b" })).toBe(true);
    expect(storedProjectMatches("/a/b", { id: "workspace", path: "/a/b" })).toBe(true);
    expect(storedProjectMatches("/a/b/../b", { path: "/a/b" })).toBe(true);
  });

  it("does not match another project", () => {
    expect(storedProjectMatches("workspace", { path: "/a/b" })).toBe(false);
    expect(storedProjectMatches("/a/c", { id: "workspace", path: "/a/b" })).toBe(false);
    expect(storedProjectMatches("/a/b", { id: "workspace" })).toBe(false);
  });

  it("matches through a symlink", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-ident-"));
    dirs.push(dir);
    const link = path.join(dir, "link");
    symlinkSync(dir, link);
    expect(storedProjectMatches(link, { path: dir })).toBe(true);
  });
});
