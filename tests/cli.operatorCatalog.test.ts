import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const runManagerCapture = vi.hoisted(() => ({
  catalogs: [] as Array<{ operatorCatalog?: { cwd?: string; agentDir?: string } }>,
}));

vi.mock("../src/runtime/runManager.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/runtime/runManager.js")
  >();
  class MockRunManager {
    constructor(opts: ConstructorParameters<typeof actual.RunManager>[0]) {
      runManagerCapture.catalogs.push({ operatorCatalog: opts.operatorCatalog });
    }
    startRun = vi.fn().mockResolvedValue({
      ok: false,
      code: "busy_capacity",
      reason: "busy",
    });
  }
  return {
    ...actual,
    RunManager: MockRunManager as unknown as typeof actual.RunManager,
  };
});

import { parseRunStageArgs } from "../src/cli.js";
import { resolveOperatorCatalog } from "../src/cli/operatorCatalog.js";
import { runRunCommand } from "../src/cli/runCommand.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const sampleTask = path.join(fixtures, "tasks", "sample.yaml");
const singlePipeline = path.join(fixtures, "pipeline-owned", "cli-smoke", "single.pipeline.yaml");

function runCli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      log: (line: string) => {
        stdout.push(line);
      },
      error: (line: string) => {
        stderr.push(line);
      },
    },
    combined() {
      return [...stdout, ...stderr].join("\n");
    },
  };
}

describe("resolveOperatorCatalog", () => {
  it("uses flags over env and defaults", () => {
    const catalog = resolveOperatorCatalog({
      flags: {
        operatorCwd: "/flag-cwd",
        operatorAgentDir: "/flag-agent",
      },
      env: {
        STAGEFLOW_OPERATOR_CWD: "/env-cwd",
        STAGEFLOW_OPERATOR_AGENT_DIR: "/env-agent",
      },
      defaultCwd: "/default-cwd",
    });
    expect(catalog).toEqual({ cwd: "/flag-cwd", agentDir: "/flag-agent" });
  });

  it("falls back to env when flags are omitted", () => {
    const catalog = resolveOperatorCatalog({
      flags: {},
      env: {
        STAGEFLOW_OPERATOR_CWD: "/env-cwd",
        STAGEFLOW_OPERATOR_AGENT_DIR: "/env-agent",
      },
      defaultCwd: "/default-cwd",
    });
    expect(catalog).toEqual({ cwd: "/env-cwd", agentDir: "/env-agent" });
  });

  it("falls back to default cwd and getAgentDir when unset", () => {
    const catalog = resolveOperatorCatalog({
      flags: {},
      env: {},
      defaultCwd: "/default-cwd",
    });
    expect(catalog.cwd).toBe("/default-cwd");
    expect(catalog.agentDir).toBe(getAgentDir());
  });

  it("treats blank flag and env values as unset", () => {
    const catalog = resolveOperatorCatalog({
      flags: { operatorCwd: "  ", operatorAgentDir: "" },
      env: {
        STAGEFLOW_OPERATOR_CWD: "\t",
        STAGEFLOW_OPERATOR_AGENT_DIR: " ",
      },
      defaultCwd: "/default-cwd",
    });
    expect(catalog.cwd).toBe("/default-cwd");
    expect(catalog.agentDir).toBe(getAgentDir());
  });
});

describe("sf run operator catalog", () => {
  afterEach(() => {
    runManagerCapture.catalogs.length = 0;
    vi.clearAllMocks();
  });

  it("unknown --operator-nope exits 1", async () => {
    const cap = captureIo();
    const code = await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline, "--operator-nope"],
      { cwd: fixtures, io: cap.io },
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Unknown flag: --operator-nope/);
  });

  it("runRunCommand passes resolved operator catalog to RunManager", async () => {
    const cap = captureIo();
    await runRunCommand(
      [
        "--task",
        sampleTask,
        "--pipeline",
        singlePipeline,
        "--operator-cwd",
        "/catalog-cwd",
        "--operator-agent-dir",
        "/catalog-agent",
      ],
      { cwd: fixtures, io: cap.io },
    );

    expect(runManagerCapture.catalogs.length).toBeGreaterThan(0);
    expect(runManagerCapture.catalogs[0]?.operatorCatalog).toEqual({
      cwd: "/catalog-cwd",
      agentDir: "/catalog-agent",
    });
  });

  it("runRunCommand uses env fallback for operator catalog", async () => {
    const cap = captureIo();
    await runRunCommand(["--task", sampleTask, "--pipeline", singlePipeline], {
      cwd: fixtures,
      io: cap.io,
      env: {
        STAGEFLOW_OPERATOR_CWD: "/env-catalog",
        STAGEFLOW_OPERATOR_AGENT_DIR: "/env-agent",
      },
    });

    expect(runManagerCapture.catalogs[0]?.operatorCatalog).toEqual({
      cwd: "/env-catalog",
      agentDir: "/env-agent",
    });
  });

  it("sf run --help mentions operator catalog flags", () => {
    const result = runCli(["run", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/--operator-cwd/);
    expect(out).toMatch(/--operator-agent-dir/);
  });

  it("parseRunStageArgs resolves operator catalog from worker flags", () => {
    const parsed = parseRunStageArgs([
      "--run-id",
      "r1",
      "--stage-id",
      "clarify",
      "--operator-cwd",
      "/worker-cwd",
      "--operator-agent-dir",
      "/worker-agent",
    ]);
    expect(parsed.operatorCatalog).toEqual({
      cwd: "/worker-cwd",
      agentDir: "/worker-agent",
    });
  });

  it("process-mode spawn passes operator catalog argv to worker", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-operator-catalog-argv-"));
    const recordPath = path.join(storeRoot, "argv.json");
    const workerPath = path.join(storeRoot, "record-argv-worker.mjs");
    await writeFile(
      workerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "const dest = process.env.RECORD_ARGV_PATH;",
        "if (dest) writeFileSync(dest, JSON.stringify(process.argv));",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );

    const launcher = new StageProcessLauncher({
      cliEntry: workerPath,
      env: { RECORD_ARGV_PATH: recordPath },
    });
    await launcher.launch({
      runId: "r1",
      stageId: "clarify",
      rootDir: storeRoot,
      operatorCatalog: {
        cwd: "/catalog-root",
        agentDir: "/agent-root",
      },
    });

    const { readFile } = await import("node:fs/promises");
    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as string[];
    expect(recorded).toContain("--operator-cwd");
    expect(recorded).toContain("/catalog-root");
    expect(recorded).toContain("--operator-agent-dir");
    expect(recorded).toContain("/agent-root");
    expect(parseRunStageArgs(recorded).operatorCatalog).toEqual({
      cwd: "/catalog-root",
      agentDir: "/agent-root",
    });
  });
});
