import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeCliRun } from "../src/cli/runCommand.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { PipelineRunResult } from "../src/runtime/pipelineRunner.js";
import type { StartRunResult } from "../src/runtime/runManager.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const singlePipeline = path.join(fixtures, "pipeline-owned", "cli-smoke", "single.pipeline.yaml");

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

function startedWith(
  result: PipelineRunResult,
): Extract<StartRunResult, { ok: true }> {
  return {
    ok: true,
    runId: result.runId,
    done: Promise.resolve(result),
  };
}

describe("cli run waiting outcome", () => {
  it("HITL park exits 2 with run folder and no success print", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cli-wait-"));
    const store = createRunStore({ rootDir: root });
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
    const started = await manager.startRun({
      task: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: singlePipeline,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const cap = captureIo();
    const code = await completeCliRun(started, cap.io);

    expect(code).toBe(2);
    expect(cap.stderr).toHaveLength(1);
    expect(cap.stderr[0]).toContain(started.runId);
    expect(cap.combined()).toContain(
      store.getWorkspaceDir(started.runId),
    );
    expect(cap.combined()).not.toMatch(/Pipeline succeeded/);
    expect(cap.combined()).not.toMatch(/Pipeline failed/);
  });

  it("no-HITL success exits 0 and prints Pipeline succeeded", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: true,
        outcome: "succeeded",
        runDir: "/tmp/runs/ok",
        runId: "run-ok",
      }),
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stdout.join("\n")).toMatch(/Pipeline succeeded/);
    expect(cap.stdout.join("\n")).toContain("/tmp/runs/ok");
  });

  it("stage failure exits 1 and prints Pipeline failed", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: false,
        outcome: "failed",
        runDir: "/tmp/runs/fail",
        runId: "run-fail",
        reason: "stage boom",
      }),
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Pipeline failed/);
    expect(cap.stderr.join("\n")).toContain("stage boom");
    expect(cap.stderr.join("\n")).toContain("/tmp/runs/fail");
  });

  it("waiting must not print Pipeline failed: undefined", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: false,
        outcome: "waiting",
        runDir: "/tmp/runs/wait",
        runId: "run-wait",
      }),
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.combined()).not.toMatch(/Pipeline failed: undefined/);
    expect(cap.combined()).not.toMatch(/Pipeline failed/);
    expect(cap.stderr.join("\n")).toContain("/tmp/runs/wait");
  });
});
