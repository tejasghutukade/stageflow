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
import { okEnvelope } from "./helpers/envelopes.js";
import { SAMPLE_TASK, SINGLE_PIPELINE } from "./helpers/fixturePaths.js";
import { waitFor } from "./helpers/waitFor.js";
import { withEnv } from "./helpers/withEnv.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

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
    expect(stageTimeoutReason(3600000)).toBe("stage timed out after 3600000ms");
    expect(isStageTimeoutReason("stage timed out after 3600000ms")).toBe(true);
    expect(isStageTimeoutReason("missing emit_stage_envelope")).toBe(false);
    expect(isStageTimeoutReason(undefined)).toBe(false);
    expect(
      lastFailedReason([
        { event: "failed", reason: "earlier" },
        { event: "failed", reason: stageTimeoutReason(1000) },
      ]),
    ).toBe("stage timed out after 1000ms");
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

  it.each([
    {
      name: "the session file is missing, without overwriting the timeout",
      behaviors: [
        { type: "throw", message: stageTimeoutReason(1000) },
        { type: "emit", envelope: okEnvelope("should-not-run") },
      ] as FakeAgentBehavior[],
      interrupt: false,
      seedSession: false,
      reason: /missing session to resume/,
      stageStatus: "failed",
      timeoutPreserved: true,
    },
    {
      name: "the stage failed for a non-timeout reason",
      behaviors: [
        { type: "never_emit" },
        { type: "emit", envelope: okEnvelope("should-not-run") },
      ] as FakeAgentBehavior[],
      interrupt: false,
      seedSession: true,
      reason: /did not fail due to timeout/,
      stageStatus: "failed",
      timeoutPreserved: false,
    },
    {
      name: "an interrupted stage has no session file",
      behaviors: [{ type: "never_emit" }] as FakeAgentBehavior[],
      interrupt: true,
      seedSession: false,
      reason: /missing session to resume/,
      stageStatus: "interrupted",
      timeoutPreserved: false,
    },
  ])(
    "rejects resume when $name",
    async ({
      behaviors,
      interrupt,
      seedSession,
      reason,
      stageStatus,
      timeoutPreserved,
    }) => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-timeout-resume-reject-"));
      const store = createRunStore({ rootDir: root });
      const agent = countingAgent(behaviors);
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

      if (interrupt) {
        await markStageInterrupted({
          store,
          runId: started.runId,
          stageId: "clarify",
          reason: "orphaned_no_worker",
          status: "interrupted",
        });
      }
      if (seedSession) {
        await seedSessionFile(store, started.runId, "clarify");
      }

      const result = await manager.resumeTimedOutStage(started.runId, "clarify");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(409);
      expect(result.reason).toMatch(reason);

      const after = await store.readRun(started.runId);
      const clarify = after.stages.find((s) => s.stage_id === "clarify");
      expect(clarify?.status).toBe(stageStatus);
      expect(clarify?.events.some((e) => e.event === "resumed")).toBe(false);
      if (timeoutPreserved) {
        expect(
          isStageTimeoutReason(lastFailedReason(clarify?.events ?? [])),
        ).toBe(true);
      }
      expect(agent.openCounts.get("clarify")).toBe(1);
    },
  );

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
});

describe("boot auto-resume cap", () => {
  it("AE25: caps automatic resumes then allows explicit resume to reset count", async () => {
    await withEnv(
      {
        [STAGEFLOW_AUTO_RESUME_INTERRUPTED]: "1",
        [STAGEFLOW_MAX_AUTO_RESUMES]: "2",
      },
      async () => {
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
      },
    );
  });

  it("leaves interrupted stages alone when auto-resume env is unset", async () => {
    await withEnv(
      {
        [STAGEFLOW_AUTO_RESUME_INTERRUPTED]: undefined,
      },
      async () => {
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
      },
    );
  });

  it("auto-resumes interrupted stages under the cap when enabled", async () => {
    await withEnv(
      {
        [STAGEFLOW_AUTO_RESUME_INTERRUPTED]: "true",
      },
      async () => {
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
      },
    );
  });
});
