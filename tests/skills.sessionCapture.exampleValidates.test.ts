import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const exampleDir = path.join(
  root,
  "skills",
  "stageflow-session-capture",
  "assets",
  "example-pipeline",
);
const pipeline = path.join(exampleDir, "example.pipeline.yaml");
const research = path.join(exampleDir, "research.yaml");
const implement = path.join(exampleDir, "implement.yaml");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
}

describe("session-capture example pipeline", () => {
  it("passes sf validate --pipeline --strict", () => {
    const result = runCli(["validate", "--pipeline", pipeline, "--strict"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });

  it("ends each stage system_prompt with emit_stage_envelope and omits gate_kinds", () => {
    const researchYaml = readFileSync(research, "utf8");
    const implementYaml = readFileSync(implement, "utf8");
    expect(researchYaml).toMatch(/emit_stage_envelope/);
    expect(implementYaml).toMatch(/emit_stage_envelope/);
    expect(researchYaml).not.toMatch(/gate_kinds/);
    expect(implementYaml).not.toMatch(/gate_kinds/);
  });

  it("contains no task yaml", () => {
    const names = readdirSync(exampleDir);
    expect(names.filter((name) => name.endsWith(".task.yaml"))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining(["example.pipeline.yaml", "research.yaml", "implement.yaml"]),
    );
  });
});
