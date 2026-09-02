import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const pkg = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as { version: string };

function runCli(args: string[], cwd: string = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("sf --version", () => {
  it("prints the package version and exits 0", () => {
    const result = runCli(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr).toBe("");
  });

  it("prints the package version on -V", () => {
    const result = runCli(["-V"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr).toBe("");
  });

  it("works outside a git project with no .stageflow", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "sf-version-"));
    const result = runCli(["--version"], cwd);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("rejects trailing tokens", () => {
    const result = runCli(["--version", "extra"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Unexpected argument: extra/);
  });
});
