import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { runRunsCommand } from "../src/cli/runsCommand.js";
import { operatorPromptEvent } from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { linearCompatDagSnapshot } from "../src/runstore/pipelineDagSnapshot.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { AskOperatorPrompt } from "../src/tools/askOperator.js";
import {
  pipelinePath,
  SAMPLE_TASK,
  SINGLE_PIPELINE,
} from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const successEnvelope = {
  status: "success" as const,
  summary: "ok",
  artifacts: [] as string[],
};

function okEnvelope(summary: string) {
  return { status: "success" as const, summary, artifacts: [] as string[] };
}

function failEnvelope(summary: string) {
  return { status: "failed" as const, summary, artifacts: [] as string[] };
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
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

describe("runRunsCommand mutate", () => {
  it("retry a failed stage reaches terminal with sf run completion JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-retry-ok-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      ["retry", "--run", started.runId, "--stage", "design-doc", "--json"],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        createManager: (s) =>
          new RunManager({
            agent: scriptedFakeAgent([
              { type: "emit", envelope: okEnvelope("design-ok-retry") },
              { type: "emit", envelope: okEnvelope("plan-ok") },
            ]),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect([0, 2]).toContain(code);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      outcome: string;
      runId: string;
    };
    expect(parsed.runId).toBe(started.runId);
    expect(["succeeded", "waiting", "failed"]).toContain(parsed.outcome);
    if (code === 0) expect(parsed.outcome).toBe("succeeded");
    if (code === 2) expect(parsed.outcome).toBe("waiting");
  });

  it("retry waiting stage exits 1 with hitl_not_retriable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-retry-hitl-"));
    const store = createRunStore({ rootDir: root });
    const prompt: AskOperatorPrompt = {
      kind: "free_text",
      id: "prompt-1",
      message: "Need input",
    };
    const created = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      pipelineDag: linearCompatDagSnapshot(["clarify"]),
    });
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
    const code = await runRunsCommand(
      ["retry", "--run", created.runId, "--stage", "clarify", "--json"],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      error: string;
      code?: string;
      status?: number;
    };
    expect(parsed.code).toBe("hitl_not_retriable");
    expect(parsed.status).toBe(409);
    expect(parsed.error).toMatch(/waiting for input/i);
  });

  it("host up refuses retry without constructing a manager", async () => {
    const cap = captureIo();
    let constructed = false;
    const code = await runRunsCommand(
      ["retry", "--run", "run-x", "--stage", "clarify", "--json"],
      {
        probeHost: async () => "up",
        createManager: () => {
          constructed = true;
          throw new Error("must not construct manager when host is up");
        },
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(constructed).toBe(false);
    expect(cap.stderr.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:3847/);
  });

  it("rerun complete run starts a new runId and blocks until stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-rerun-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([{ type: "emit", envelope: successEnvelope }]),
      store,
      cwd: fixtures,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const cap = captureIo();
    const code = await runRunsCommand(
      ["rerun", "--run", started.runId, "--json"],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        createManager: (s) =>
          new RunManager({
            agent: scriptedFakeAgent([
              { type: "emit", envelope: successEnvelope },
            ]),
            store: s,
            cwd: fixtures,
          }),
        io: cap.io,
      },
    );
    expect([0, 2]).toContain(code);
    const parsed = JSON.parse(cap.stdout.join("\n")) as {
      outcome: string;
      runId: string;
    };
    expect(parsed.runId).not.toBe(started.runId);
    expect(["succeeded", "waiting", "failed"]).toContain(parsed.outcome);
  });

  it("abandon --json returns { ok, runId, stageId } on a seeded running stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runs-abandon-"));
    const store = createRunStore({ rootDir: root });
    const created = await store.createRun({
      pipelineId: "test-pipeline",
      taskYaml: "id: a\ngoal: g\n",
      taskId: "a",
      pipelineDag: linearCompatDagSnapshot(["stage-a"]),
    });
    await store.ensureStageWorkspace(created.runId, "stage-a");
    await store.createStageExecution(created.runId, "stage-a");
    await store.appendStageEvent(created.runId, "stage-a", { event: "started" });
    await store.updateRunStatus(created.runId, "running");

    const cap = captureIo();
    const code = await runRunsCommand(
      ["abandon", "--run", created.runId, "--stage", "stage-a", "--json"],
      {
        cwd: fixtures,
        projectRoot: root,
        store,
        probeHost: async () => "down",
        io: cap.io,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout.join("\n"))).toEqual({
      ok: true,
      runId: created.runId,
      stageId: "stage-a",
    });
    const after = await store.readRun(created.runId);
    expect(after.stages.find((s) => s.stage_id === "stage-a")?.status).toBe(
      "failed",
    );
  });

  it("host up refuses abandon", async () => {
    const cap = captureIo();
    let constructed = false;
    const code = await runRunsCommand(
      ["abandon", "--run", "run-x", "--stage", "stage-a"],
      {
        probeHost: async () => "up",
        createManager: () => {
          constructed = true;
          throw new Error("must not construct manager when host is up");
        },
        io: cap.io,
      },
    );
    expect(code).toBe(1);
    expect(constructed).toBe(false);
    expect(cap.stderr.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:3847/);
  });
});
