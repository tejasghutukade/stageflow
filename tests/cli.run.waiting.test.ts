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
import { SINGLE_PIPELINE, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const singlePipeline = SINGLE_PIPELINE;

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
      task: SAMPLE_TASK,
      pipeline: singlePipeline,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const cap = captureIo();
    const code = await completeCliRun(started, cap.io);

    expect(code).toBe(2);
    expect(cap.stdout.join("\n")).toContain(`Run ${started.runId}`);
    expect(cap.combined()).toContain(`sf runs show --run ${started.runId}`);
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
    const text = cap.stdout.join("\n");
    expect(text).toMatch(/Pipeline succeeded/);
    expect(text).toContain("Run run-ok");
    expect(text).toContain("sf runs show --run run-ok");
    expect(text).toContain("/#/runs/run-ok");
    expect(text).toContain("/tmp/runs/ok");
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
    const text = cap.stderr.join("\n");
    expect(text).toMatch(/Pipeline failed/);
    expect(text).toContain("stage boom");
    expect(text).toContain("Run run-fail");
    expect(text).toContain("sf runs show --run run-fail");
    expect(text).toContain("/tmp/runs/fail");
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
    expect(cap.stderr.join("\n")).toContain("sf runs show --run run-wait");
  });

  it("names the waiting stage and the answer command", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: false,
        outcome: "waiting",
        runDir: "/tmp/runs/wait",
        runId: "run-wait",
        waitingStageId: "review",
      }),
      cap.io,
    );
    expect(code).toBe(2);
    const text = cap.stderr.join("\n");
    expect(text).toContain("Pipeline waiting on review.");
    expect(text).toContain("sf runs answer --run run-wait --stage review");
  });

  it("prints the parked question and skips the generic wait phrase", async () => {
    const asked = captureIo();
    await completeCliRun(
      startedWith({
        ok: false,
        outcome: "waiting",
        runDir: "/tmp/runs/wait",
        runId: "run-wait",
        waitingStageId: "review",
        waitingSummary: "Publish this one-line brief?",
      }),
      asked.io,
    );
    const text = asked.stderr.join("\n");
    const waitingAt = text.indexOf("Pipeline waiting on review.");
    const questionAt = text.indexOf("Publish this one-line brief?");
    expect(waitingAt).toBeGreaterThanOrEqual(0);
    expect(questionAt).toBeGreaterThan(waitingAt);

    const generic = captureIo();
    await completeCliRun(
      startedWith({
        ok: false,
        outcome: "waiting",
        runDir: "/tmp/runs/wait",
        runId: "run-wait",
        waitingStageId: "review",
        waitingSummary: "Waiting for input",
      }),
      generic.io,
    );
    expect(generic.stderr.join("\n")).not.toContain("Waiting for input");
  });

  it("names the failed stage and the retry command", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: false,
        outcome: "failed",
        runDir: "/tmp/runs/fail",
        runId: "run-fail",
        reason: "stage boom",
        failedStageId: "draft",
      }),
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toContain(
      "sf runs retry --run run-fail --stage draft",
    );
  });

  it("prints cost from the run result when no store is passed", async () => {
    const cap = captureIo();
    const code = await completeCliRun(
      startedWith({
        ok: true,
        outcome: "succeeded",
        runDir: "/tmp/runs/ok",
        runId: "run-ok",
        totalCostUsd: 0.0123,
      }),
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stderr.join("\n")).toContain("Cost: $0.0123");
  });
});
