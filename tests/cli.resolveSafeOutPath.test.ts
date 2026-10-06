import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSafeOutPath } from "../src/cli/resolveSafeOutPath.js";

describe("resolveSafeOutPath", () => {
  it("accepts relative and same-dir absolute paths", () => {
    const cwd = process.cwd();
    expect(resolveSafeOutPath("out.json", cwd)).toBe(path.join(cwd, "out.json"));
    expect(resolveSafeOutPath(path.join(cwd, "out.json"), cwd)).toBe(
      path.join(cwd, "out.json"),
    );
  });

  it("rejects .. segments and paths outside cwd", () => {
    const cwd = process.cwd();
    expect(() => resolveSafeOutPath("../out.json", cwd)).toThrow(
      /path must not contain \.\. segments/,
    );
    expect(() => resolveSafeOutPath("/etc/sf-safe-out-outside.json", cwd)).toThrow(
      /output path must resolve under the current working directory/,
    );
  });

  it("accepts absolute --out that realpath-aliases cwd (/tmp vs /private/tmp)", () => {
    let tmpReal: string;
    try {
      tmpReal = realpathSync("/tmp");
    } catch {
      return;
    }
    const tmpResolved = path.resolve("/tmp");
    if (tmpReal === tmpResolved) {
      expect(resolveSafeOutPath("/tmp/sf-safe-out.json", "/tmp")).toBe(
        path.resolve("/tmp/sf-safe-out.json"),
      );
      return;
    }
    expect(resolveSafeOutPath("/tmp/sf-safe-out.json", tmpReal)).toBe(
      path.resolve("/tmp/sf-safe-out.json"),
    );
    expect(resolveSafeOutPath("/tmp/sf-safe-out.json", "/tmp")).toBe(
      path.resolve("/tmp/sf-safe-out.json"),
    );
  });
});
