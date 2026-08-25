import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../src/config/validateCatalog.js";
import {
  formatValidationHuman,
  formatValidationJson,
} from "../src/cli/validateOutput.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");

function runCli(args: string[], cwd = fixtures) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("sf run validation gate", { timeout: 30_000 }, () => {
  it("AE-S3-1: broken pipeline exits 1 with formatted findings and no success line", () => {
    const result = runCli([
      "run",
      "--task",
      "tasks/sample.yaml",
      "--pipeline",
      "broken",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toMatch(/Pipeline succeeded/);
    expect(result.stderr).toMatch(/error:/i);
    expect(result.stderr).toMatch(/missing stage/i);
    expect(result.stderr).toMatch(/broken/);
  });

  it("validation failure does not print preparePipeline stack trace", () => {
    const result = runCli([
      "run",
      "--task",
      "tasks/sample.yaml",
      "--pipeline",
      "broken",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/at preparePipeline/);
    expect(result.stderr).not.toMatch(/at async runPipeline/);
  });

  it("AE-S3-3: run validation stderr matches validate human output for broken pipeline", async () => {
    const validation = await validateCatalog({
      scope: "pipeline",
      cwd: fixtures,
      pipeline: "broken",
    });
    const expected = formatValidationHuman(validation);

    const validateResult = runCli(["validate", "--pipeline", "broken"]);
    expect(validateResult.status).toBe(1);

    const runResult = runCli([
      "run",
      "--task",
      "tasks/sample.yaml",
      "--pipeline",
      "broken",
    ]);
    expect(runResult.status).toBe(1);
    expect(runResult.stderr.trim()).toBe(expected.trim());
    expect(validateResult.stdout.trim() + validateResult.stderr.trim()).toBe(
      expected.trim(),
    );
  });

  it("AE5: --json on a validation-gate reject prints validate-shaped JSON, no runId", async () => {
    const validation = await validateCatalog({
      scope: "pipeline",
      cwd: fixtures,
      pipeline: "broken",
    });
    const result = runCli([
      "run",
      "--json",
      "--task",
      "tasks/sample.yaml",
      "--pipeline",
      "broken",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(formatValidationJson(validation).trim());
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      findings: unknown;
      runId?: string;
      outcome?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed).not.toHaveProperty("runId");
    expect(parsed).not.toHaveProperty("outcome");
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(result.stdout).not.toMatch(/Pipeline succeeded|Pipeline failed/);
  });
});
