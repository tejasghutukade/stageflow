import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("CLI stub", { timeout: 10_000 }, () => {
  it("exits non-zero on missing args and prints usage", () => {
    const result = runCli([]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Usage:/);
  });

  it("prints usage on --help and exits zero", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/sf ui/);
    expect(result.stdout).toMatch(/--checkout/);
    expect(result.stdout).toMatch(/sf validate/);
    expect(result.stdout).toMatch(/--pipeline/);
    expect(result.stdout).toMatch(/--strict/);
    expect(result.stdout).toMatch(/--json/);
    expect(result.stdout).toMatch(/sf providers list/);
    expect(result.stdout).toMatch(/status/);
    expect(result.stdout).toMatch(/detect/);
    expect(result.stdout).toMatch(/source/);
    expect(result.stdout).toMatch(/login/);
    expect(result.stdout).toMatch(/logout/);
    expect(result.stdout).toMatch(/Stageflow \(sf\)/);
    expect(result.stdout).not.toMatch(/software-factory \(sf\)/);
    expect(result.stdout).toMatch(/Data under \.stageflow\/\./);
    expect(result.stdout).not.toMatch(/\.software-factory/);
  });

  it("rejects --checkout without a value", () => {
    const result = runCli(["run", "--task", "t.yaml", "--pipeline", "p", "--checkout"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Missing value for --checkout/);
  });

  it("providers with no subcommand exits non-zero with usage", () => {
    const result = runCli(["providers"]);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf providers list/);
    expect(out).toMatch(/login/);
    expect(out).toMatch(/logout/);
  });

  it("providers unknown subcommand exits non-zero", () => {
    const result = runCli(["providers", "nope"]);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Unknown providers subcommand: nope/);
    expect(out).not.toMatch(/stack|at Object|Error: /i);
  });

  it("validate --help prints validate usage and exits zero", () => {
    const result = runCli(["validate", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf validate/);
    expect(out).toMatch(/--pipeline/);
    expect(out).toMatch(/--strict/);
    expect(out).toMatch(/--json/);
  });

  it("validate --pipeline without value exits non-zero", () => {
    const result = runCli(["validate", "--pipeline"]);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Missing value for --pipeline/);
    expect(out).not.toMatch(/stack|at Object|Error: /i);
  });

  it("validate unknown flag exits non-zero with usage", () => {
    const result = runCli(["validate", "--nope"]);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Unknown flag: --nope/);
    expect(out).toMatch(/sf validate/);
    expect(out).not.toMatch(/stack|at Object|Error: /i);
  });
});
