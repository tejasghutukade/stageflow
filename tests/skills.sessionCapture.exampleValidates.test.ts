import { spawnSync } from "node:child_process";
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
});
