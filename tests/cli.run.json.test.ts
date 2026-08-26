import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { runRunCommand } from "../src/cli/runCommand.js";
import { formatValidationJson } from "../src/cli/validateOutput.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { PipelineValidationError } from "../src/runtime/pipelineRunner.js";
import type { PipelineRunResult } from "../src/runtime/pipelineRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StartRunResult } from "../src/runtime/runManager.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { validateCatalog } from "../src/config/validateCatalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const sampleTask = path.join(fixtures, "tasks", "sample.yaml");
const singlePipeline = path.join(fixtures, "pipeline-owned", "cli-smoke", "single.pipeline.yaml");
const brokenPipeline = path.join(fixtures, "manifest-catalog", "pipelines", "broken.pipeline.yaml");

function gatedAgent(gate: Promise<void>) {
  return {
    openStage(input: { stage: { id: string } }) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => {
          await gate;
          return {
            ok: true as const,
            envelope: {
              status: "success" as const,
              summary: "ok",
              artifacts: [],
            },
          };
        },
      });
    },
    async runStage() {
      await gate;
      return {
        ok: true as const,
        envelope: {
          status: "success" as const,
          summary: "ok",
          artifacts: [],
        },
      };
    },
  };
}

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
    stdoutText() {
      return stdout.join("\n");
    },
    stderrText() {
      return stderr.join("\n");
    },
  };
}

describe("sf run --json parse (U1)", { timeout: 15_000 }, () => {
  it("sf run --help mentions --json on the run usage line", () => {
    const result = runCli(["run", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf run[^\n]*--json/);
  });

  it("top-level --help mentions --json on the run usage line", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf run[^\n]*--json/);
  });

  it("sf run --nope prints Unknown flag on stderr and exits 1", () => {
    const result = runCli(["run", "--nope"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown flag: --nope/);
    expect(result.stdout).toBe("");
  });

  it("sf run --json without --task/--pipeline stays human on stderr with no stdout JSON", () => {
    const result = runCli(["run", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing --task and\/or --pipeline/);
    expect(result.stdout.trim()).toBe("");
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  it("unknown flag does not start a Run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-run-json-unknown-"));
    const startRun = vi.fn();
    const cap = captureIo();
    const code = await runRunCommand(["--nope"], { cwd, io: cap.io, startRun });
    expect(code).toBe(1);
    expect(startRun).not.toHaveBeenCalled();
    expect(cap.stderrText()).toMatch(/Unknown flag: --nope/);

    const spawned = runCli(["run", "--nope"], cwd);
    expect(spawned.status).toBe(1);
    const stageflowDir = path.join(cwd, ".stageflow");
    await expect(readdir(stageflowDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("sf run start-failure mapping (U2)", () => {
  it("human busy start exits 1 with busy_capacity stderr, never 409", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-run-json-busy-"));
    const store = createRunStore({ rootDir: storeRoot });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 1,
      executionMode: "inprocess",
    });
    const first = await manager.startRun({
      pipeline: singlePipeline,
      task: { id: "hold", goal: "hold slot" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const cap = captureIo();
    const code = await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: (input) => manager.startRun(input),
      },
    );
    expect(code).toBe(1);
    expect(code).not.toBe(409);
    expect(cap.stderrText()).toMatch(/busy_capacity:/);
    expect(cap.stdoutText()).toBe("");

    release();
    await first.done;
  });

  it("--json busy start prints busy envelope without runId and exits 1", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-run-json-busy-json-"));
    const store = createRunStore({ rootDir: storeRoot });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 1,
      executionMode: "inprocess",
    });
    const first = await manager.startRun({
      pipeline: singlePipeline,
      task: { id: "hold", goal: "hold slot" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: (input) => manager.startRun(input),
      },
    );
    expect(code).toBe(1);
    expect(cap.stderrText()).not.toMatch(/busy_capacity/);
    const parsed = JSON.parse(cap.stdoutText()) as {
      ok: boolean;
      outcome: string;
      code: string;
      reason: string;
      activeCount: number;
      maxConcurrent: number;
      activeRunIds: string[];
      runId?: string;
      runDir?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.outcome).toBe("busy");
    expect(parsed.code).toBe("busy_capacity");
    expect(parsed.reason).toMatch(/Capacity full/);
    expect(parsed.activeCount).toBe(1);
    expect(parsed.maxConcurrent).toBe(1);
    expect(parsed.activeRunIds).toEqual([first.runId]);
    expect(parsed).not.toHaveProperty("runId");
    expect(parsed).not.toHaveProperty("runDir");
    expect(parsed).not.toHaveProperty("conflictingRunId");
    expect(parsed).not.toHaveProperty("conflictingCheckout");

    release();
    await first.done;
  });

  it("busy_checkout JSON includes conflict keys when present and omits them when absent", async () => {
    const withConflict: Extract<StartRunResult, { ok: false }> = {
      ok: false,
      reason: "Checkout in use by run run-hold",
      status: 409,
      code: "busy_checkout",
      activeCount: 1,
      maxConcurrent: 3,
      activeRunIds: ["run-hold"],
      conflictingRunId: "run-hold",
      conflictingCheckout: "/tmp/checkout",
    };
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      { io: cap.io, startRun: async () => withConflict },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.stdoutText()) as Record<string, unknown>;
    expect(parsed.outcome).toBe("busy");
    expect(parsed.code).toBe("busy_checkout");
    expect(parsed.conflictingRunId).toBe("run-hold");
    expect(parsed.conflictingCheckout).toBe("/tmp/checkout");
    expect(parsed).not.toHaveProperty("runId");

    const withoutConflict: Extract<StartRunResult, { ok: false }> = {
      ok: false,
      reason: "Checkout in use by run unknown",
      status: 409,
      code: "busy_checkout",
      activeCount: 1,
      maxConcurrent: 3,
      activeRunIds: ["provisional"],
    };
    const cap2 = captureIo();
    await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      { io: cap2.io, startRun: async () => withoutConflict },
    );
    const parsed2 = JSON.parse(cap2.stdoutText()) as Record<string, unknown>;
    expect(parsed2.outcome).toBe("busy");
    expect(parsed2).not.toHaveProperty("conflictingRunId");
    expect(parsed2).not.toHaveProperty("conflictingCheckout");
  });

  it("non-busy start reject JSON is outcome failed, never busy", async () => {
    const rejected: Extract<StartRunResult, { ok: false }> = {
      ok: false,
      reason: "task file missing",
      status: 400,
    };
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      { io: cap.io, startRun: async () => rejected },
    );
    expect(code).toBe(1);
    expect(code).not.toBe(400);
    const parsed = JSON.parse(cap.stdoutText()) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: false,
      outcome: "failed",
      reason: "task file missing",
    });
    expect(parsed).not.toHaveProperty("runId");
    expect(cap.stderrText()).toBe("");
  });
});

function startedOk(result: PipelineRunResult): Extract<StartRunResult, { ok: true }> {
  return {
    ok: true,
    runId: result.runId,
    done: Promise.resolve(result),
  };
}

describe("sf run --json completion (U3)", () => {
  it("no-HITL success prints succeeded envelope on stdout and exits 0", async () => {
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      {
        io: cap.io,
        startRun: async () =>
          startedOk({
            ok: true,
            outcome: "succeeded",
            runId: "run-ok",
            runDir: "/tmp/runs/ok",
          }),
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdoutText()) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      outcome: "succeeded",
      runId: "run-ok",
      runDir: "/tmp/runs/ok",
    });
    expect(cap.stdoutText()).not.toMatch(/Pipeline succeeded/);
    expect(cap.stderrText()).toBe("");
  });

  it("HITL park prints waiting envelope and exits 2", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-run-json-wait-"));
    const store = createRunStore({ rootDir: storeRoot });
    const launch = vi.fn(async ({ runId, stageId }) => {
      await store.appendStageEvent(runId, stageId, {
        event: "waiting_for_input",
      });
      return { type: "waiting" as const };
    });
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncher,
    });
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: (input) => manager.startRun(input),
      },
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdoutText()) as {
      ok: boolean;
      outcome: string;
      runId: string;
      runDir: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.outcome).toBe("waiting");
    expect(parsed.runId).toBeTruthy();
    expect(parsed.runDir).toContain(parsed.runId);
    expect(cap.stdoutText()).not.toMatch(/Pipeline waiting|Pipeline succeeded|Pipeline failed/);
    expect(cap.stderrText()).toBe("");
  });

  it("started stage failure prints failed envelope and exits 1", async () => {
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      {
        io: cap.io,
        startRun: async () =>
          startedOk({
            ok: false,
            outcome: "failed",
            runId: "run-fail",
            runDir: "/tmp/runs/fail",
            reason: "stage boom",
          }),
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.stdoutText()) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: false,
      outcome: "failed",
      runId: "run-fail",
      runDir: "/tmp/runs/fail",
      reason: "stage boom",
    });
    expect(cap.stdoutText()).not.toMatch(/Pipeline failed/);
    expect(cap.stderrText()).toBe("");
  });

  it("validation gate under --json prints validate-shaped JSON with no runId", async () => {
    const validation = await validateCatalog({
      scope: "pipeline",
      cwd: fixtures,
      pipeline: brokenPipeline,
    });
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", brokenPipeline],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: async () => {
          throw new PipelineValidationError(validation);
        },
      },
    );
    expect(code).toBe(1);
    expect(cap.stdoutText()).toBe(formatValidationJson(validation));
    const parsed = JSON.parse(cap.stdoutText()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed).not.toHaveProperty("runId");
    expect(parsed).not.toHaveProperty("outcome");
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(cap.stderrText()).toBe("");
  });

  it("unexpected throw produces no stdout JSON", async () => {
    const cap = captureIo();
    const code = await runRunCommand(
      ["--json", "--task", sampleTask, "--pipeline", singlePipeline],
      {
        io: cap.io,
        startRun: async () => {
          throw new Error("unexpected boom");
        },
      },
    );
    expect(code).toBe(1);
    expect(cap.stdoutText()).toBe("");
    expect(() => JSON.parse(cap.stdoutText())).toThrow();
    expect(cap.stderrText()).toBe("unexpected boom");
  });
});
