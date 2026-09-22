import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  scriptedFakeAgent,
  type FakeAgentBehavior,
} from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import {
  isStageTimeoutReason,
  lastFailedReason,
  stageTimeoutReason,
} from "../src/agent/stageTimeout.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { attemptSessionPath } from "../src/runstore/workspaceLayout.js";
import { assertResumableStage } from "../src/runtime/resumeTimedOut.js";
import {
  RunManager,
  STAGEFLOW_AUTO_RESUME_INTERRUPTED,
  STAGEFLOW_MAX_AUTO_RESUMES,
} from "../src/runtime/runManager.js";
import { markStageInterrupted } from "../src/runtime/stageRecovery.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { SAMPLE_TASK, SINGLE_PIPELINE } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(summary: string): StageEnvelope {
  return { status: "success", summary, artifacts: [], payload: {} };
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

function countingAgent(
  behaviorsByOpen: FakeAgentBehavior[],
): AgentPort & { openCounts: Map<string, number>; sessionModes: string[] } {
  const openCounts = new Map<string, number>();
  const sessionModes: string[] = [];
  let index = 0;
  return {
    openCounts,
    sessionModes,
    openStage(input: StageRunInput) {
      openCounts.set(
        input.stage.id,
        (openCounts.get(input.stage.id) ?? 0) + 1,
      );
      sessionModes.push(input.sessionMode ?? "fresh");
      const behavior = behaviorsByOpen[index] ?? { type: "never_emit" as const };
      index += 1;
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

async function seedSessionFile(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  stageId: string,
  attempt = 1,
): Promise<void> {
  const sessionFile = attemptSessionPath(
    store.getWorkspaceDir(runId),
    stageId,
    attempt,
  );
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '{"role":"assistant","text":"partial work"}\n');
}

describe("stageTimeout helpers", () => {
  it("recognizes timeout fail reasons", () => {
    expect(isStageTimeoutReason(stageTimeoutReason(3600000))).toBe(true);
    expect(isStageTimeoutReason("missing emit_stage_envelope")).toBe(false);
    expect(isStageTimeoutReason(undefined)).toBe(false);
    expect(
      lastFailedReason([
        { event: "failed", reason: "earlier" },
        { event: "failed", reason: stageTimeoutReason(1000) },
      ]),
    ).toBe(stageTimeoutReason(1000));
  });

  it("assertResumableStage allows interrupted and failed timeout stages", () => {
    expect(
      assertResumableStage("failed", [
        { event: "failed", reason: stageTimeoutReason(5000) },
      ]),
    ).toEqual({ ok: true });
    expect(
      assertResumableStage("interrupted", [
        { event: "interrupted", reason: "orphaned_no_worker" },
      ]),
    ).toEqual({ ok: true });
    expect(
      assertResumableStage("running", [
        { event: "failed", reason: stageTimeoutReason(5000) },
      ]).ok,
    ).toBe(false);
    const notTimeout = assertResumableStage("failed", [
      { event: "failed", reason: "missing emit_stage_envelope" },
    ]);
    expect(notTimeout.ok).toBe(false);
    if (!notTimeout.ok) {
      expect(notTimeout.status).toBe(409);
      expect(notTimeout.reason).toMatch(/use retry/);
    }
  });
});

describe("timeout resume", () => {
  it("continues the same attempt instead of starting over", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-"));
    const store = createRunStore({ rootDir: root });
    const timeoutMs = 60_000;
    const agent = countingAgent([
      { type: "throw", message: stageTimeoutReason(timeoutMs) },
      { type: "emit", envelope: okEnvelope("clarify-resumed") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    const before = await store.readRun(started.runId);
    const timedOut = before.stages.find((s) => s.stage_id === "clarify");
    expect(timedOut?.attempt_count).toBe(1);
    expect(isStageTimeoutReason(lastFailedReason(timedOut?.events ?? []))).toBe(
      true,
    );

    await seedSessionFile(store, started.runId, "clarify");

    const resumed = await manager.resumeTimedOutStage(
      started.runId,
      "clarify",
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.attemptIndex).toBe(1);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const after = await store.readRun(started.runId);
    const clarify = after.stages.find((s) => s.stage_id === "clarify");
    expect(clarify?.status).toBe("succeeded");
    expect(clarify?.attempt_count).toBe(1);
    expect(clarify?.events.some((e) => e.event === "resumed")).toBe(true);
    expect(agent.openCounts.get("clarify")).toBe(2);
    expect(agent.sessionModes).toEqual(["fresh", "timeout_resume"]);
  });

  it("rejects resume when the session file is missing without overwriting the timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-missing-"));
    const store = createRunStore({ rootDir: root });
    const agent = countingAgent([
      { type: "throw", message: stageTimeoutReason(1000) },
      { type: "emit", envelope: okEnvelope("should-not-run") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    const result = await manager.resumeTimedOutStage(started.runId, "clarify");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.reason).toMatch(/missing session to resume/);

    const after = await store.readRun(started.runId);
    const clarify = after.stages.find((s) => s.stage_id === "clarify");
    expect(clarify?.status).toBe("failed");
    expect(isStageTimeoutReason(lastFailedReason(clarify?.events ?? []))).toBe(
      true,
    );
    expect(clarify?.events.some((e) => e.event === "resumed")).toBe(false);
    expect(agent.openCounts.get("clarify")).toBe(1);
  });

  it("rejects resume on a non-timeout failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-not-"));
    const store = createRunStore({ rootDir: root });
    const agent = countingAgent([
      { type: "never_emit" },
      { type: "emit", envelope: okEnvelope("should-not-run") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    await seedSessionFile(store, started.runId, "clarify");
    const result = await manager.resumeTimedOutStage(started.runId, "clarify");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.reason).toMatch(/did not fail due to timeout/);
    expect(agent.openCounts.get("clarify")).toBe(1);
  });

  it("AE9: resumes an interrupted stage on the same attempt when session exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-interrupted-resume-"));
    const store = createRunStore({ rootDir: root });
    const agent = countingAgent([
      { type: "never_emit" },
      { type: "emit", envelope: okEnvelope("clarify-resumed") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    await markStageInterrupted({
      store,
      runId: started.runId,
      stageId: "clarify",
      reason: "orphaned_no_worker",
      status: "interrupted",
    });
    await store.updateRunStatus(started.runId, "running");
    await seedSessionFile(store, started.runId, "clarify");

    const before = await store.getLatestStageExecution(started.runId, "clarify");
    expect(before?.attempt).toBe(1);
    expect(before?.status).toBe("interrupted");

    const resumed = await manager.resumeTimedOutStage(started.runId, "clarify");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.attemptIndex).toBe(1);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const after = await store.readRun(started.runId);
    const clarify = after.stages.find((s) => s.stage_id === "clarify");
    expect(clarify?.status).toBe("succeeded");
    expect(clarify?.attempt_count).toBe(1);
    expect(clarify?.events.some((e) => e.event === "resumed")).toBe(true);
    expect(agent.sessionModes.at(-1)).toBe("timeout_resume");
    const execution = await store.getStageExecution(started.runId, "clarify", 1);
    expect(execution.auto_resume_count).toBe(0);
  });

  it("refuses interrupted resume when the session file is missing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sf-interrupted-resume-missing-"),
    );
    const store = createRunStore({ rootDir: root });
    const agent = countingAgent([{ type: "never_emit" }]);
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: SINGLE_PIPELINE,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status === "failed"
      );
    });

    await markStageInterrupted({
      store,
      runId: started.runId,
      stageId: "clarify",
      reason: "orphaned_no_worker",
      status: "interrupted",
    });

    const result = await manager.resumeTimedOutStage(started.runId, "clarify");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.reason).toMatch(/missing session to resume/);
    const after = await store.readRun(started.runId);
    expect(
      after.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("interrupted");
  });
});

describe("boot auto-resume cap", () => {
  it("AE25: caps automatic resumes then allows explicit resume to reset count", async () => {
    const previousAuto = process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
    const previousMax = process.env[STAGEFLOW_MAX_AUTO_RESUMES];
    process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED] = "1";
    process.env[STAGEFLOW_MAX_AUTO_RESUMES] = "2";
    try {
      const root = await mkdtemp(path.join(tmpdir(), "sf-auto-resume-cap-"));
      const store = createRunStore({ rootDir: root });
      const agent = countingAgent([
        { type: "never_emit" },
        { type: "emit", envelope: okEnvelope("clarify-resumed") },
      ]);
      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: SAMPLE_TASK,
        pipeline: SINGLE_PIPELINE,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "failed"
        );
      });

      await markStageInterrupted({
        store,
        runId: started.runId,
        stageId: "clarify",
        reason: "orphaned_no_worker",
        status: "interrupted",
      });
      await store.updateRunStatus(started.runId, "running");
      const execution = await store.getLatestStageExecution(
        started.runId,
        "clarify",
      );
      expect(execution).not.toBeNull();
      await store.updateStageExecution(
        started.runId,
        "clarify",
        execution!.attempt,
        { auto_resume_count: 2 },
      );

      const auto = await manager.autoResumeInterruptedStages();
      expect(auto.capped).toEqual([
        { runId: started.runId, stageId: "clarify" },
      ]);
      expect(auto.resumed).toEqual([]);

      const cappedDetail = await store.readRun(started.runId);
      const clarify = cappedDetail.stages.find((s) => s.stage_id === "clarify");
      expect(clarify?.status).toBe("interrupted");
      expect(
        clarify?.events.some(
          (e) =>
            e.event === "interrupted" && e.reason === "auto_resume_capped",
        ),
      ).toBe(true);
      const cappedExec = await store.getStageExecution(
        started.runId,
        "clarify",
        1,
      );
      expect(cappedExec.auto_resume_count).toBe(2);

      await seedSessionFile(store, started.runId, "clarify");
      const resumed = await manager.resumeTimedOutStage(
        started.runId,
        "clarify",
      );
      expect(resumed.ok).toBe(true);
      const reset = await store.getStageExecution(started.runId, "clarify", 1);
      expect(reset.auto_resume_count).toBe(0);

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "succeeded";
      });
    } finally {
      if (previousAuto === undefined) {
        delete process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
      } else {
        process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED] = previousAuto;
      }
      if (previousMax === undefined) {
        delete process.env[STAGEFLOW_MAX_AUTO_RESUMES];
      } else {
        process.env[STAGEFLOW_MAX_AUTO_RESUMES] = previousMax;
      }
    }
  });

  it("leaves interrupted stages alone when auto-resume env is unset", async () => {
    const previousAuto = process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
    delete process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
    try {
      const root = await mkdtemp(path.join(tmpdir(), "sf-auto-resume-off-"));
      const store = createRunStore({ rootDir: root });
      const agent = countingAgent([{ type: "never_emit" }]);
      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: SAMPLE_TASK,
        pipeline: SINGLE_PIPELINE,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "failed"
        );
      });

      await markStageInterrupted({
        store,
        runId: started.runId,
        stageId: "clarify",
        reason: "orphaned_no_worker",
        status: "interrupted",
      });
      await store.updateRunStatus(started.runId, "running");
      await seedSessionFile(store, started.runId, "clarify");

      const auto = await manager.autoResumeInterruptedStages();
      expect(auto).toEqual({ resumed: [], capped: [], skipped: [] });

      const after = await store.readRun(started.runId);
      expect(
        after.stages.find((s) => s.stage_id === "clarify")?.status,
      ).toBe("interrupted");
      expect(agent.openCounts.get("clarify")).toBe(1);
    } finally {
      if (previousAuto === undefined) {
        delete process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
      } else {
        process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED] = previousAuto;
      }
    }
  });

  it("auto-resumes interrupted stages under the cap when enabled", async () => {
    const previousAuto = process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
    process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED] = "true";
    try {
      const root = await mkdtemp(path.join(tmpdir(), "sf-auto-resume-on-"));
      const store = createRunStore({ rootDir: root });
      const agent = countingAgent([
        { type: "never_emit" },
        { type: "emit", envelope: okEnvelope("clarify-auto") },
      ]);
      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: SAMPLE_TASK,
        pipeline: SINGLE_PIPELINE,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        return (
          detail.stages.find((s) => s.stage_id === "clarify")?.status ===
          "failed"
        );
      });

      await markStageInterrupted({
        store,
        runId: started.runId,
        stageId: "clarify",
        reason: "orphaned_no_worker",
        status: "interrupted",
      });
      await store.updateRunStatus(started.runId, "running");
      await seedSessionFile(store, started.runId, "clarify");

      const auto = await manager.autoResumeInterruptedStages();
      expect(auto.resumed).toEqual([
        { runId: started.runId, stageId: "clarify" },
      ]);
      expect(auto.capped).toEqual([]);

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "succeeded";
      });

      const execution = await store.getStageExecution(
        started.runId,
        "clarify",
        1,
      );
      expect(execution.auto_resume_count).toBe(1);
    } finally {
      if (previousAuto === undefined) {
        delete process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
      } else {
        process.env[STAGEFLOW_AUTO_RESUME_INTERRUPTED] = previousAuto;
      }
    }
  });
});
