import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExportRunCommand } from "../src/cli/exportRunCommand.js";
import { RUNS_USAGE, runRunsCommand } from "../src/cli/runsCommand.js";
import { operatorPromptEvent } from "../src/hitl/qaTrail.js";
import { projectRun } from "../src/projection/projectRun.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStatus, RunStore } from "../src/runstore/port.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import type { StageEnvelope } from "../src/types/envelope.js";

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

async function seedRun(
  projectRoot: string,
  options: {
    stageIds?: string[];
    runStatus?: RunStatus;
    envelopes?: Record<string, StageEnvelope>;
    completeStages?: boolean;
  } = {},
): Promise<{ runId: string; store: RunStore }> {
  const store = createRunStore({ rootDir: projectRoot });
  const stageIds = options.stageIds ?? ["stage-a", "stage-b"];
  const completeStages = options.completeStages ?? true;
  const created = await store.createRun({
    pipelineId: "test-pipeline",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
    pipelineDag: linearCompatDagSnapshot(stageIds),
  });

  for (const stageId of stageIds) {
    await store.ensureStageWorkspace(created.runId, stageId);
    if (!completeStages && stageId !== stageIds[0]) {
      continue;
    }
    await store.createStageExecution(created.runId, stageId);
    await store.appendStageEvent(created.runId, stageId, { event: "started" });
    if (completeStages) {
      await store.appendStageEvent(created.runId, stageId, { event: "succeeded" });
    }
    const envelope = options.envelopes?.[stageId];
    if (envelope) {
      await store.writeEnvelope(created.runId, stageId, envelope);
    }
  }

  const runStatus = options.runStatus ?? "succeeded";
  if (runStatus !== "created") {
    await store.updateRunStatus(created.runId, runStatus);
  }

  return { runId: created.runId, store };
}

describe("runRunsCommand inspect/wait", () => {
  it("list --json seeded ids match listRuns", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-list-"));
    const { runId, store } = await seedRun(projectRoot);
    const cap = captureIo();
    const code = await runRunsCommand(["list", "--json"], {
      projectRoot,
      store,
      io: cap.io,
    });
    expect(code).toBe(0);
    const listed = await store.listRuns();
    const parsed = JSON.parse(cap.stdout.join("\n")) as { runs: unknown };
    expect(parsed.runs).toEqual(listed);
    expect(listed.map((r) => r.run_id)).toContain(runId);
  });

  it("show --json on a running run returns projectRun", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-show-"));
    const { runId, store } = await seedRun(projectRoot, {
      completeStages: false,
      runStatus: "running",
    });
    const cap = captureIo();
    const code = await runRunsCommand(["show", "--run", runId, "--json"], {
      projectRoot,
      store,
      io: cap.io,
    });
    expect(code).toBe(0);
    const detail = await store.readRun(runId);
    expect(detail.status).toBe("running");
    const parsed = JSON.parse(cap.stdout.join("\n"));
    expect(parsed).toEqual(projectRun(detail));
  });

  it("waiting --json includes pending_prompt for a parked stage", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-waiting-"));
    const store = createRunStore({ rootDir: projectRoot });
    const created = await store.createRun({
      pipelineId: "test-pipeline",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      pipelineDag: linearCompatDagSnapshot(["clarify"]),
    });
    const prompt: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-1",
      message: "Module name?",
    };
    await store.ensureStageWorkspace(created.runId, "clarify");
    await store.createStageExecution(created.runId, "clarify");
    await store.appendStageEvent(created.runId, "clarify", { event: "started" });
    await store.appendStageEvent(
      created.runId,
      "clarify",
      operatorPromptEvent(prompt),
    );
    await store.appendStageEvent(created.runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.updateRunStatus(created.runId, "running");

    const cap = captureIo();
    const code = await runRunsCommand(["waiting", "--json"], {
      projectRoot,
      store,
      io: cap.io,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      waiting: Array<Record<string, unknown>>;
    };
    expect(parsed.waiting).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: created.runId,
          stageId: "clarify",
          pending_prompt: prompt,
        }),
      ]),
    );
    const meta = await store.readRunMeta(created.runId);
    expect(meta.status).toBe("running");
  });

  it("wait --until terminal on already-failed run is reason already, exit 0", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-wait-alr-"));
    const { runId, store } = await seedRun(projectRoot, {
      runStatus: "failed",
    });
    const cap = captureIo();
    const code = await runRunsCommand(
      ["wait", "--run", runId, "--until", "terminal", "--json"],
      { projectRoot, store, io: cap.io },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      ok: boolean;
      reason: string;
      until: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe("already");
    expect(parsed.until).toBe("terminal");
  });

  it("wait --timeout-ms 1000 on a running run times out with exit 0", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-wait-to-"));
    const { runId, store } = await seedRun(projectRoot, {
      completeStages: false,
      runStatus: "running",
    });
    const before = await store.readRun(runId);
    const cap = captureIo();
    const code = await runRunsCommand(
      ["wait", "--run", runId, "--timeout-ms", "1000", "--json"],
      { projectRoot, store, io: cap.io },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      ok: boolean;
      reason: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe("timeout");
    const after = await store.readRun(runId);
    expect(after.status).toBe(before.status);
  });

  it("list --status waiting exits 1 and mentions sf runs waiting", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-stat-w-"));
    const { store } = await seedRun(projectRoot);
    const cap = captureIo();
    const code = await runRunsCommand(["list", "--status", "waiting"], {
      projectRoot,
      store,
      io: cap.io,
    });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/sf runs waiting/);
    expect(cap.stdout.join("\n")).toBe("");
  });

  it("show unknown runId exits 1 with human stderr and no stack", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-unk-"));
    const store = createRunStore({ rootDir: projectRoot });
    const cap = captureIo();
    const code = await runRunsCommand(["show", "--run", "no-such-run"], {
      projectRoot,
      store,
      io: cap.io,
    });
    expect(code).toBe(1);
    const err = cap.stderr.join("\n");
    expect(err).toMatch(/not found/i);
    expect(err).not.toMatch(/stack|at Object|    at /);
  });

  it("wait --timeout-ms 0 returns clamp error from waitRun", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-clamp-"));
    const { runId, store } = await seedRun(projectRoot);
    const cap = captureIo();
    const code = await runRunsCommand(
      ["wait", "--run", runId, "--timeout-ms", "0", "--json"],
      { projectRoot, store, io: cap.io },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      error: string;
      status?: number;
    };
    expect(parsed.error).toMatch(/timeout_ms must be in \(0, 240000]/);
    expect(parsed.status).toBe(400);
  });

  it("wait aborted via waitSignal exits 130 and leaves run unchanged", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-abort-"));
    const { runId, store } = await seedRun(projectRoot, {
      completeStages: false,
      runStatus: "running",
    });
    const before = await store.readRun(runId);
    const controller = new AbortController();
    controller.abort();
    const cap = captureIo();
    const code = await runRunsCommand(
      ["wait", "--run", runId, "--timeout-ms", "5000", "--json"],
      {
        projectRoot,
        store,
        io: cap.io,
        waitSignal: controller.signal,
      },
    );
    expect(code).toBe(130);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      error: string;
      code: string;
    };
    expect(parsed.error).toMatch(/abort/i);
    expect(parsed.code).toBe("aborted");
    const after = await store.readRun(runId);
    expect(after.status).toBe(before.status);
  });

  it("export-run still rejects the in-progress id that show accepts", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "sf-runs-export-"));
    const { runId, store } = await seedRun(projectRoot, {
      completeStages: false,
      runStatus: "running",
    });
    const showCap = captureIo();
    const showCode = await runRunsCommand(["show", "--run", runId, "--json"], {
      projectRoot,
      store,
      io: showCap.io,
    });
    expect(showCode).toBe(0);
    expect(JSON.parse(showCap.stdout.join("\n")).status).toBe("running");

    const exportCap = captureIo();
    const exportCode = await runExportRunCommand(["--run", runId], {
      cwd: projectRoot,
      projectRoot,
      io: exportCap.io,
    });
    expect(exportCode).toBe(1);
    expect(exportCap.stderr.join("\n")).toMatch(/run is not complete/);
  });

  it("unknown subcommand prints USAGE and exits 1", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(["nope"], { io: cap.io });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toContain("Unknown runs subcommand: nope");
    expect(cap.stderr.join("\n")).toContain(RUNS_USAGE);
  });

  it("--help prints USAGE on stderr and exits 0", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(["--help"], { io: cap.io });
    expect(code).toBe(0);
    expect(cap.stderr.join("\n")).toBe(RUNS_USAGE);
    expect(cap.stdout).toEqual([]);
  });

  it("unknown flag is human stderr plus USAGE even with --json", async () => {
    const cap = captureIo();
    const code = await runRunsCommand(["list", "--nope", "--json"], {
      io: cap.io,
    });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toMatch(/Unknown flag: --nope/);
    expect(cap.stderr.join("\n")).toContain(RUNS_USAGE);
    expect(cap.stdout.join("\n")).not.toMatch(/\{/);
  });
});
