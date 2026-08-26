import { describe, expect, it, vi } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { parseRunStageArgs } from "../src/cli.js";
import { runRunCommand } from "../src/cli/runCommand.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageLaunchInput } from "../src/runtime/stageProcessLauncher.js";
import {
  isRunStageWaiting,
  runStage,
} from "../src/runtime/stageRunner.js";
import { startUiServer } from "../src/server/http.js";
import type { StartRunResult } from "../src/runtime/runManager.js";
import type { PipelineRunResult } from "../src/runtime/pipelineRunner.js";
import type { AgentPort } from "../src/agent/port.js";
import type { RunStore } from "../src/runstore/port.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const sampleTask = SAMPLE_TASK;
const singlePipeline = SINGLE_PIPELINE;

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

function succeededStart(): Extract<StartRunResult, { ok: true }> {
  const result: PipelineRunResult = {
    ok: true,
    outcome: "succeeded",
    runDir: "/tmp/runs/ok",
    runId: "run-ok",
  };
  return { ok: true, runId: result.runId, done: Promise.resolve(result) };
}

const waitThenEmit = {
  type: "wait_then_emit" as const,
  waitRequests: ["need-input"],
  envelope: {
    status: "success" as const,
    summary: "done",
    artifacts: [] as string[],
  },
};

function workerLikeLauncher(
  store: RunStore,
  agent: AgentPort,
): { launch: (input: StageLaunchInput) => Promise<{ type: "waiting" } | { type: "succeeded" } | { type: "failed"; reason: string }> } {
  return {
    async launch(input: StageLaunchInput) {
      const outcome = await runStage({
        agent,
        store,
        runId: input.runId,
        stage: {
          id: input.stageId,
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "sample", goal: "g" },
        priorEnvelope: null,
        workerMode: true,
        skipGates: input.skipGates,
      });
      if (isRunStageWaiting(outcome)) return { type: "waiting" as const };
      if ("ok" in outcome && outcome.ok) return { type: "succeeded" as const };
      return {
        type: "failed" as const,
        reason: "reason" in outcome ? outcome.reason : "stage failed",
      };
    },
  };
}

describe("sf run --skip-gates parse (U1)", { timeout: 15_000 }, () => {
  it("sf run --help mentions --skip-gates on the run usage line", () => {
    const result = runCli(["run", "--help"]);
    expect(result.status).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/sf run[^\n]*--skip-gates/);
  });

  it("top-level --help mentions --skip-gates on the run usage line", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sf run[^\n]*--skip-gates/);
  });

  it("unknown flags still exit 1; --skip-gates is a known flag", async () => {
    const unknown = runCli(["run", "--nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown flag: --nope/);

    const startRun = vi.fn(async () => succeededStart());
    const cap = captureIo();
    const code = await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline, "--skip-gates"],
      { cwd: fixtures, io: cap.io, startRun },
    );
    expect(code).toBe(0);
    expect(startRun).toHaveBeenCalled();
    expect(cap.combined()).not.toMatch(/Unknown flag: --skip-gates/);
  });

  it("guest start with --skip-gates sets the option true on startRun", async () => {
    const startRun = vi.fn(async () => succeededStart());
    const cap = captureIo();
    await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline, "--skip-gates"],
      { cwd: fixtures, io: cap.io, startRun },
    );
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ skipGates: true }),
    );
  });

  it("guest start without --skip-gates leaves the option false", async () => {
    const startRun = vi.fn(async () => succeededStart());
    const cap = captureIo();
    await runRunCommand(["--task", sampleTask, "--pipeline", singlePipeline], {
      cwd: fixtures,
      io: cap.io,
      startRun,
    });
    const input = startRun.mock.calls[0]?.[0] as { skipGates?: boolean };
    expect(input.skipGates).toBeFalsy();
  });

  it("guest start with --skip-gates threads true through RunManager to the launcher", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-launch-"));
    const store = createRunStore({ rootDir: storeRoot });
    const launch = vi.fn(async ({ runId, stageId }: StageLaunchInput) => {
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
    const started = await manager.startRun({
      task: sampleTask,
      pipeline: singlePipeline,
      skipGates: true,
    });
    expect(started.ok).toBe(true);
    if (started.ok) await started.done;
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ skipGates: true }),
    );
  });

  it("guest start without skipGates leaves launcher option false", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-off-"));
    const store = createRunStore({ rootDir: storeRoot });
    const launch = vi.fn(async ({ runId, stageId }: StageLaunchInput) => {
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
    const started = await manager.startRun({
      task: sampleTask,
      pipeline: singlePipeline,
    });
    expect(started.ok).toBe(true);
    if (started.ok) await started.done;
    const input = launch.mock.calls[0]?.[0] as StageLaunchInput;
    expect(input.skipGates).toBeFalsy();
  });

  it("parseRunStageArgs accepts --skip-gates and defaults false", () => {
    const withFlag = parseRunStageArgs([
      "--run-id",
      "r1",
      "--stage-id",
      "clarify",
      "--skip-gates",
    ]);
    expect(withFlag.skipGates).toBe(true);

    const without = parseRunStageArgs([
      "--run-id",
      "r1",
      "--stage-id",
      "clarify",
    ]);
    expect(without.skipGates).toBeFalsy();
  });

  it("process-mode spawn passes argv --skip-gates only when true", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-argv-"));
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

    const withFlag = new StageProcessLauncher({
      cliEntry: workerPath,
      env: { RECORD_ARGV_PATH: recordPath },
    });
    await withFlag.launch({
      runId: "r1",
      stageId: "clarify",
      rootDir: storeRoot,
      skipGates: true,
    });
    const { readFile } = await import("node:fs/promises");
    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as string[];
    expect(recorded).toContain("--skip-gates");
    expect(parseRunStageArgs(recorded)).toEqual(
      expect.objectContaining({ skipGates: true, runId: "r1", stageId: "clarify" }),
    );

    const offPath = path.join(storeRoot, "argv-off.json");
    const withoutFlag = new StageProcessLauncher({
      cliEntry: workerPath,
      env: { RECORD_ARGV_PATH: offPath },
    });
    await withoutFlag.launch({
      runId: "r1",
      stageId: "clarify",
      rootDir: storeRoot,
    });
    const recordedOff = JSON.parse(await readFile(offPath, "utf8")) as string[];
    expect(recordedOff).not.toContain("--skip-gates");
    expect(parseRunStageArgs(recordedOff).skipGates).toBeFalsy();
  });
});

describe("sf run --skip-gates guest proof (U3)", { timeout: 20_000 }, () => {
  it("--skip-gates + HITL exits 1 with store failed and no waiting_for_input", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-cli-on-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([waitThenEmit]);
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: workerLikeLauncher(
        store,
        agent,
      ) as unknown as StageProcessLauncher,
    });
    const cap = captureIo();
    const code = await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline, "--skip-gates"],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: (input) => manager.startRun(input),
      },
    );
    expect(code).toBe(1);
    expect(cap.combined()).toMatch(/Pipeline failed/);
    expect(cap.combined()).not.toMatch(/Pipeline succeeded/);
    expect(cap.combined()).not.toMatch(/Pipeline waiting/);
    expect(cap.combined()).not.toMatch(/Pipeline failed: undefined/);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const detail = await store.readRun(runs[0]!.run_id);
    expect(detail.status).not.toBe("waiting");
    expect(
      detail.stages.some((s) => s.status === "waiting_for_input"),
    ).toBe(false);
    expect(detail.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "failed",
    );
    const events = await store.listStageEvents(runs[0]!.run_id, "clarify");
    expect(events.some((e) => e.event === "waiting_for_input")).toBe(false);
  });

  it("no flag + HITL exits 2 with store waiting", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-cli-off-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = scriptedFakeAgent([waitThenEmit]);
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: workerLikeLauncher(
        store,
        agent,
      ) as unknown as StageProcessLauncher,
    });
    const cap = captureIo();
    const code = await runRunCommand(
      ["--task", sampleTask, "--pipeline", singlePipeline],
      {
        cwd: fixtures,
        io: cap.io,
        startRun: (input) => manager.startRun(input),
      },
    );
    expect(code).toBe(2);
    expect(cap.combined()).toMatch(/Pipeline waiting/);
    expect(cap.combined()).not.toMatch(/Pipeline succeeded/);
    expect(cap.combined()).not.toMatch(/Pipeline failed/);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const detail = await store.readRun(runs[0]!.run_id);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
  });

  it("POST /api/runs HITL still parks", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-http-"));
    const store = createRunStore({ rootDir: storeRoot });
    const started = await startUiServer({
      agent: scriptedFakeAgent([waitThenEmit]),
      cwd: fixtures,
      store,
      port: 0,
      uiDistDir: path.join(storeRoot, "missing-ui"),
    });
    const address = started.server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const res = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "tasks/sample.task.yaml",
          pipeline: singlePipeline,
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { runId: string };
      const deadline = Date.now() + 5000;
      let parked = false;
      while (Date.now() < deadline) {
        const detail = await store.readRun(body.runId);
        if (
          detail.stages.some((s) => s.status === "waiting_for_input")
        ) {
          parked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(parked).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
