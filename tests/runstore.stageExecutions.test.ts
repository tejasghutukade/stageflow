import { describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import {
  attemptAgentDir,
  attemptArtifactsDir,
  attemptEnvelopePath,
  attemptLogPath,
  attemptWorkspaceDir,
} from "../src/runstore/workspaceLayout.js";
import { plantDiskEraRun } from "./helpers/plantDiskEraRun.js";

const kinds = ["sqlite"] as const;

async function seedTwoAttempts(
  store: RunStore,
  runId: string,
  stageId: string,
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 1 });
  await store.appendStageEvent(
    runId,
    stageId,
    { event: "failed", reason: "fail" },
    { attempt: 1 },
  );
  await store.updateStageExecution(runId, stageId, 1, {
    status: "failed",
    envelope: { status: "failure", summary: "fail", artifacts: [] },
  });

  await store.createStageExecution(runId, stageId);
  await store.ensureAttemptWorkspace(runId, stageId, 2);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 2 });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt: 2 });
  await store.updateStageExecution(runId, stageId, 2, {
    status: "succeeded",
    envelope: { status: "success", summary: "ok", artifacts: [] },
  });
}

describe.each(kinds)("stage executions (%s)", (kind) => {
  it("assigns sequential attempt numbers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-seq-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    const first = await store.createStageExecution(run.runId, "build");
    const second = await store.createStageExecution(run.runId, "build");
    const third = await store.createStageExecution(run.runId, "build");

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    expect(third.attempt).toBe(3);
    expect(first.status).toBe("pending");
    expect(first.verification_outcome).toBe("not_run");

    await store.updateStageExecution(run.runId, "build", 1, {
      verification_outcome: "failed",
    });
    await expect(
      store.getStageExecution(run.runId, "build", 1),
    ).resolves.toMatchObject({ verification_outcome: "failed" });
  });

  it("AE1: lists two attempts with distinct statuses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-ae1-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");

    const executions = await store.listStageExecutions(run.runId, "build");
    expect(executions).toHaveLength(2);
    expect(executions[0]?.attempt).toBe(1);
    expect(executions[1]?.attempt).toBe(2);
    expect(executions[0]?.status).toBe("failed");
    expect(executions[1]?.status).toBe("succeeded");
  });

  it("AE2: retains attempt 1 envelope after attempt 2 succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-ae2-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");

    const attempt1 = await store.getStageExecution(run.runId, "build", 1);
    expect(attempt1.envelope?.summary).toBe("fail");
    expect(attempt1.status).toBe("failed");

    const attempt2 = await store.getStageExecution(run.runId, "build", 2);
    expect(attempt2.envelope?.summary).toBe("ok");
  });

  it("countStageAttempts and getLatestStageExecution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-count-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");

    expect(await store.countStageAttempts(run.runId, "build")).toBe(2);
    const latest = await store.getLatestStageExecution(run.runId, "build");
    expect(latest?.attempt).toBe(2);
    expect(latest?.status).toBe("succeeded");
  });

  it("getStageExecution throws for missing attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-miss-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await expect(
      store.getStageExecution(run.runId, "build", 1),
    ).rejects.toThrow(/not found/);
  });

  it("listStageEvents filters by attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-events-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");

    const attempt1Events = await store.listStageEvents(run.runId, "build", 1);
    const attempt2Events = await store.listStageEvents(run.runId, "build", 2);

    expect(attempt1Events.some((e) => e.event === "failed")).toBe(true);
    expect(attempt1Events.some((e) => e.event === "succeeded")).toBe(false);
    expect(attempt2Events.some((e) => e.event === "succeeded")).toBe(true);
    expect(attempt2Events.some((e) => e.event === "failed")).toBe(false);
  });

  it("persists verification evidence independently for each attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-verification-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\\ngoal: g\\n",
    });

    await store.createStageExecution(run.runId, "build");
    await store.upsertVerificationCheckResult(run.runId, "build", {
      check_id: "unit-tests",
      check_type: "command",
      status: "running",
      started_at: "2026-09-03T10:00:00.000Z",
    });
    await store.upsertVerificationCheckResult(run.runId, "build", {
      check_id: "unit-tests",
      check_type: "command",
      status: "failed",
      finished_at: "2026-09-03T10:00:02.000Z",
      evidence: { exit_code: 1, stderr: "expected true to be false" },
    });

    await store.createStageExecution(run.runId, "build");
    await store.upsertVerificationCheckResult(run.runId, "build", {
      check_id: "unit-tests",
      check_type: "command",
      status: "passed",
      started_at: "2026-09-03T10:01:00.000Z",
      finished_at: "2026-09-03T10:01:01.000Z",
      evidence: { exit_code: 0, stdout: "all tests passed" },
    }, { attempt: 2 });

    await expect(
      store.listVerificationCheckResults(run.runId, "build", 1),
    ).resolves.toEqual([
      {
        run_id: run.runId,
        stage_id: "build",
        attempt: 1,
        check_id: "unit-tests",
        check_type: "command",
        status: "failed",
        started_at: "2026-09-03T10:00:00.000Z",
        finished_at: "2026-09-03T10:00:02.000Z",
        evidence: { exit_code: 1, stderr: "expected true to be false" },
      },
    ]);
    await expect(
      store.listVerificationCheckResults(run.runId, "build", 2),
    ).resolves.toEqual([
      {
        run_id: run.runId,
        stage_id: "build",
        attempt: 2,
        check_id: "unit-tests",
        check_type: "command",
        status: "passed",
        started_at: "2026-09-03T10:01:00.000Z",
        finished_at: "2026-09-03T10:01:01.000Z",
        evidence: { exit_code: 0, stdout: "all tests passed" },
      },
    ]);
    await expect(
      store.listVerificationCheckResults(run.runId, "build"),
    ).resolves.toHaveLength(2);
  });

  it("rejects verification evidence for an execution that does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-verification-missing-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\\ngoal: g\\n",
    });

    await expect(
      store.upsertVerificationCheckResult(run.runId, "build", {
        check_id: "unit-tests",
        check_type: "command",
        status: "passed",
      }),
    ).rejects.toThrow(/Stage execution not found/);
  });

  it("attempt workspace dirs exist after ensureAttemptWorkspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-ws-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.createStageExecution(run.runId, "build");
    await store.ensureAttemptWorkspace(run.runId, "build", 1);

    const ws = store.getWorkspaceDir(run.runId);
    await expect(access(attemptArtifactsDir(ws, "build", 1))).resolves.toBeUndefined();
    await expect(access(attemptAgentDir(ws, "build", 1))).resolves.toBeUndefined();
    expect(attemptLogPath(ws, "build", 1)).toContain(
      path.join("stages", "build", "attempts", "1", "log.jsonl"),
    );

    await store.createStageExecution(run.runId, "build");
    await store.ensureAttemptWorkspace(run.runId, "build", 2);

    await expect(access(attemptArtifactsDir(ws, "build", 2))).resolves.toBeUndefined();
    expect(attemptWorkspaceDir(ws, "build", 2)).toContain(
      path.join("stages", "build", "attempts", "2"),
    );
  });

  it("AE4: readRun for retried stage returns latest-attempt envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-ae4-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");

    const detail = await store.readRun(run.runId);
    const build = detail.stages.find((s) => s.stage_id === "build");
    expect(build?.attempt_count).toBe(2);
    expect(build?.status).toBe("succeeded");
    expect(build?.envelope?.summary).toBe("ok");
  });

  it("AE3: legacy append without attempt keeps readRun behavior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-exec-legacy-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.updateRunStatus(run.runId, "succeeded");

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("succeeded");
    expect(detail.stages).toHaveLength(1);
    expect(detail.stages[0]?.status).toBe("succeeded");
    expect(detail.stages[0]?.envelope?.summary).toBe("ok");
  });
});

describe("stage executions (sqlite import)", () => {
  it("writeEnvelope requires a pre-existing execution row", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-exec-write-req-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await expect(
      store.writeEnvelope(run.runId, "clarify", {
        status: "success",
        summary: "ok",
        artifacts: [],
      }),
    ).rejects.toThrow(/not found/);
  });

  it("writeEnvelope persists envelope on execution row without disk file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-exec-write-sqlite-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", {
      status: "success",
      summary: "sqlite-only",
      artifacts: [],
    });

    const execution = await store.getStageExecution(run.runId, "clarify", 1);
    expect(execution.envelope?.summary).toBe("sqlite-only");

    const workspaceDir = store.getWorkspaceDir(run.runId);
    await expect(
      access(attemptEnvelopePath(workspaceDir, "clarify", 1)),
    ).rejects.toThrow();
  });

  it("readRun ignores stale stages.envelope_json when execution rows exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-exec-stale-env-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await seedTwoAttempts(store, run.runId, "build");
    await store.writeEnvelope(run.runId, "build", {
      status: "failure",
      summary: "stale",
      artifacts: [],
    });

    const detail = await store.readRun(run.runId);
    const build = detail.stages.find((s) => s.stage_id === "build");
    expect(build?.envelope?.summary).toBe("ok");
    expect(build?.attempt_count).toBe(2);
  });

  it("disk import creates attempt 1 execution rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-exec-import-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const runId = "legacy-disk-run";
    await plantDiskEraRun(root, {
      runId,
      pipelineId: "docs-only",
      taskYaml: "id: legacy\ngoal: migrate me\n",
      taskId: "legacy",
      checkoutRoot: checkout,
      status: "succeeded",
      stageId: "clarify",
      events: [{ event: "started" }, { event: "succeeded" }],
      envelope: {
        status: "success",
        summary: "from disk",
        artifacts: [],
      },
    });

    const sqlite = createRunStore({ rootDir: root, kind: "sqlite" });
    if (sqlite instanceof SqliteRunStore) {
      await sqlite.ready();
    }

    const executions = await sqlite.listStageExecutions(runId, "clarify");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.attempt).toBe(1);
    expect(executions[0]?.status).toBe("succeeded");
    expect(executions[0]?.envelope?.summary).toBe("from disk");
  });
});
