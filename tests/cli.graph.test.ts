import { describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGraphCommand } from "../src/cli/graph.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { FIXTURES_ROOT, pipelinePath } from "./helpers/fixturePaths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const featureLoopPipeline = path.join(root, "examples", "feature-loop", "feature-loop.pipeline.yaml");

function runCli(args: string[], cwd = fixtures) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("sf graph", () => {
  it("shows help with --help flag", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGraphCommand(["--help"], {
      cwd: fixtures,
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(code).toBe(0);
    const output = [...logs, ...errors].join("\n");
    expect(output).toMatch(/sf graph --pipeline <path> \[--json\]/);
  });

  it("fails when --pipeline is missing", async () => {
    const errors: string[] = [];
    const code = await runGraphCommand([], {
      cwd: fixtures,
      io: {
        log: () => {},
        error: (line) => errors.push(line),
      },
    });
    
    expect(code).toBe(1);
    const output = errors.join("\n");
    expect(output).toMatch(/Missing required --pipeline argument/);
  });

  it("can render feature-loop pipeline as ASCII diagram", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", featureLoopPipeline], {
      cwd: root,
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toMatch(/Pipeline Graph/);
    expect(output).toMatch(/decompose/);
    expect(output).toMatch(/plan/);
    expect(output).toMatch(/align/);
    expect(output).toMatch(/implement/);
    expect(output).toMatch(/verify/);
    expect(output).toMatch(/review/);
    expect(output).toMatch(/address-feedback/);
    expect(output).toMatch(/publish/);
  });

  it("can render feature-loop pipeline as JSON", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runGraphCommand(["--pipeline", featureLoopPipeline, "--json"], {
      cwd: root,
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toMatch(/"nodes":/);
    expect(output).toMatch(/"roots":/);
    expect(output).toMatch(/"childrenOf":/);
    
    // Parse JSON to verify structure
    const jsonData = JSON.parse(logs.join("\n"));
    expect(jsonData.nodes).toBeDefined();
    expect(Array.isArray(jsonData.nodes)).toBe(true);
    expect(jsonData.roots).toBeDefined();
    expect(typeof jsonData.childrenOf).toBe("object");
  });

  it("CLI accepts graph command", () => {
    const result = runCli(["graph", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/sf graph --pipeline <path> \[--json\]/);
  });

  it("CLI rejects graph command with no pipeline", () => {
    const result = runCli(["graph"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Missing required --pipeline argument/);
  });
});