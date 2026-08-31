import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { sameCliEntry } from "../src/cli.js";
import { runRunCommand } from "../src/cli/runCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StartRunResult } from "../src/runtime/runManager.js";
import type { PipelineRunResult } from "../src/runtime/pipelineRunner.js";
import { SAMPLE_TASK, SINGLE_PIPELINE, pipelinePath } from "./helpers/fixturePaths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const sampleTask = SAMPLE_TASK;
const singlePipeline = SINGLE_PIPELINE;
const docsOnlyPipeline = pipelinePath("docs-only");
const brokenPipeline = path.join(fixtures, "manifest-catalog", "pipelines", "broken.pipeline.yaml");
const manifestCatalog = path.join(fixtures, "manifest-catalog");
const demoPipeline = path.join(manifestCatalog, "pipelines", "demo.pipeline.yaml");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("sameCliEntry", () => {
  it("treats .ts and missing .js siblings as the same entry", () => {
    const tsEntry = path.join(root, "src", "cli.ts");
    const jsSibling = path.join(root, "src", "cli.js");
    expect(sameCliEntry(tsEntry, jsSibling)).toBe(true);
    expect(sameCliEntry(jsSibling, tsEntry)).toBe(true);
  });
});

describe("CLI stub", { timeout: 15_000 }, () => {
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
    expect(result.stdout).toMatch(/sf mcp/);
    expect(result.stdout).toMatch(/--mcp-stateless/);
    expect(result.stdout).toMatch(/--checkout/);
    expect(result.stdout).toMatch(/sf run[^\n]*--json/);
    expect(result.stdout).toMatch(/sf validate/);
    expect(result.stdout).toMatch(/sf init/);
    expect(result.stdout).not.toMatch(/name-or-path/);
    expect(result.stdout).toMatch(/--pipeline <path>/);
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
    expect(out).toMatch(/--pipeline <path>/);
    expect(out).toMatch(/--task <path>/);
    expect(out).toMatch(/manifest-all|stageflow\.yaml/i);
    expect(out).not.toMatch(/name-or-path/);
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

  it("run --help mentions --json and path-based pipeline", () => {
    const result = runCli(["run", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf run[^\n]*--json/);
    expect(out).toMatch(/--pipeline <path>/);
    expect(out).not.toMatch(/name-or-path/);
  });

  it("run unknown flag exits non-zero with usage", () => {
    const result = runCli(["run", "--nope"]);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/Unknown flag: --nope/);
    expect(out).toMatch(/sf run/);
    expect(out).not.toMatch(/stack|at Object|Error: /i);
  });

  it("sf --help and sf run --help mention CI identity flags", () => {
    const top = runCli(["--help"]);
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/sf run[^\n]*--git-sha/);
    expect(top.stdout).toMatch(/sf run[^\n]*--ci-pr-url/);
    expect(top.stdout).toMatch(/sf run[^\n]*--ci-job-url/);

    const runHelp = runCli(["run", "--help"]);
    expect(runHelp.status).toBe(0);
    const out = runHelp.stdout + runHelp.stderr;
    expect(out).toMatch(/sf run[^\n]*--git-sha/);
    expect(out).toMatch(/sf run[^\n]*--ci-pr-url/);
    expect(out).toMatch(/sf run[^\n]*--ci-job-url/);
  });

  it("rejects --git-sha without a value", () => {
    const result = runCli([
      "run",
      "--task",
      "t.yaml",
      "--pipeline",
      "p",
      "--git-sha",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Missing value for --git-sha/);
  });

  it("CI identity flags are known and are not Unknown flag", async () => {
    const startRun = vi.fn(async (): Promise<StartRunResult> => {
      const result: PipelineRunResult = {
        ok: true,
        outcome: "succeeded",
        runDir: "/tmp/runs/ok",
        runId: "run-ok",
      };
      return { ok: true, runId: result.runId, done: Promise.resolve(result) };
    });
    const stderr: string[] = [];
    const code = await runRunCommand(
      [
        "--task",
        sampleTask,
        "--pipeline",
        singlePipeline,
        "--git-sha",
        "deadbeef",
        "--ci-pr-url",
        "https://github.com/acme/repo/pull/1",
        "--ci-job-url",
        "https://github.com/acme/repo/actions/runs/9/job/8",
      ],
      {
        cwd: fixtures,
        io: {
          log: () => undefined,
          error: (line) => {
            stderr.push(line);
          },
        },
        startRun,
        env: {},
      },
    );
    expect(code).toBe(0);
    expect(stderr.join("\n")).not.toMatch(/Unknown flag/);
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        gitSha: "deadbeef",
        ciPrUrl: "https://github.com/acme/repo/pull/1",
        ciJobUrl: "https://github.com/acme/repo/actions/runs/9/job/8",
      }),
    );
  });

  it("CLI startRun extras appear on readRunMeta after create", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-cli-ci-stamp-"));
    const store = createRunStore({ rootDir: storeRoot });
    const manager = new RunManager({
      agent: scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "ok", artifacts: [] },
        },
      ]),
      store,
      cwd: fixtures,
      executionMode: "inprocess",
    });
    const stderr: string[] = [];
    const code = await runRunCommand(
      [
        "--task",
        sampleTask,
        "--pipeline",
        singlePipeline,
        "--git-sha",
        "deadbeef",
        "--ci-pr-url",
        "https://github.com/acme/repo/pull/42",
        "--ci-job-url",
        "https://github.com/acme/repo/actions/runs/99",
      ],
      {
        cwd: fixtures,
        io: {
          log: () => undefined,
          error: (line) => {
            stderr.push(line);
          },
        },
        startRun: (input) => manager.startRun(input),
        env: {},
      },
    );
    expect(code).toBe(0);
    expect(stderr.join("\n")).not.toMatch(/Unknown flag/);
    const listed = await store.listRuns();
    expect(listed).toHaveLength(1);
    const meta = await store.readRunMeta(listed[0]!.run_id);
    expect(meta.git_sha).toBe("deadbeef");
    expect(meta.ci_pr_url).toBe("https://github.com/acme/repo/pull/42");
    expect(meta.ci_job_url).toBe("https://github.com/acme/repo/actions/runs/99");
  });

  it("AE1: bare pipeline name fails with actionable error", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "sf-cli-bare-pipeline-"));
    const result = spawnSync(process.execPath, [tsxCli, cli, "run", "--task", sampleTask, "--pipeline", "single"], {
      cwd: emptyDir,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/not found|filesystem path/i);
    expect(out).not.toMatch(/Pipeline succeeded/);
  });
});
