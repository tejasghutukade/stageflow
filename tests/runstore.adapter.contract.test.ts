import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { buildStageSnapshotFromStore } from "../src/runstore/stageSnapshot.js";
import {
  attemptAgentDir,
  attemptEnvelopePath,
} from "../src/runstore/workspaceLayout.js";
import type { StageEnvelope } from "../src/types/envelope.js";

type AdapterKind = "sqlite";

const adapters: { kind: AdapterKind; label: string }[] = [
  { kind: "sqlite", label: "SqliteRunStore" },
];

function buildStore(root: string, kind: AdapterKind): RunStore {
  return createRunStore({ rootDir: root, kind });
}

const defaultTaskYaml = "id: t\ngoal: g\n";
const stageId = "clarify";

const envelopeAttempt1: StageEnvelope = {
  status: "success",
  summary: "attempt-1",
  artifacts: [],
};

const envelopeAttempt2: StageEnvelope = {
  status: "success",
  summary: "attempt-2",
  artifacts: [],
};

describe.each(adapters)("$label RunStore contract", ({ kind }) => {
  let root: string;
  let store: RunStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), `sf-contract-${kind}-`));
    store = buildStore(root, kind);
  });

  it("createRun → readRunMeta roundtrip", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
      taskId: "t",
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.run_id).toBe(run.runId);
    expect(meta.pipeline_id).toBe("docs-only");
    expect(meta.task_id).toBe("t");
    expect(meta.created_at).toBeTruthy();
  });

  it("ensureStageWorkspace + createStageExecution → listStageExecutions attempt 1", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });

    await store.ensureStageWorkspace(run.runId, stageId);
    const created = await store.createStageExecution(run.runId, stageId);

    expect(created.attempt).toBe(1);
    expect(created.status).toBe("pending");

    const executions = await store.listStageExecutions(run.runId, stageId);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.attempt).toBe(1);
  });

  it("writeEnvelope(attempt=1) → readEnvelope roundtrip", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });

    await store.createStageExecution(run.runId, stageId);
    await store.writeEnvelope(run.runId, stageId, envelopeAttempt1, { attempt: 1 });

    await expect(store.readEnvelope(run.runId, stageId)).resolves.toEqual(
      envelopeAttempt1,
    );

    const workspaceDir = store.getWorkspaceDir(run.runId);
    if (kind === "sqlite") {
      await expect(
        access(attemptEnvelopePath(workspaceDir, stageId, 1)),
      ).rejects.toThrow();
    }
  });

  it("writeEnvelope(attempt=2) → readEnvelope returns attempt-2 envelope", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });

    await store.createStageExecution(run.runId, stageId);
    await store.writeEnvelope(run.runId, stageId, envelopeAttempt1, { attempt: 1 });
    await store.createStageExecution(run.runId, stageId);
    await store.ensureAttemptWorkspace(run.runId, stageId, 2);
    await store.writeEnvelope(run.runId, stageId, envelopeAttempt2, { attempt: 2 });

    await expect(store.readEnvelope(run.runId, stageId)).resolves.toEqual(
      envelopeAttempt2,
    );
  });

  it("buildStageSnapshotFromStore with execution row", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });
    const workspaceDir = store.getWorkspaceDir(run.runId);

    await store.createStageExecution(run.runId, stageId);
    await store.appendStageEvent(run.runId, stageId, { event: "started" }, { attempt: 1 });
    await store.writeEnvelope(run.runId, stageId, envelopeAttempt1, { attempt: 1 });
    await store.createStageExecution(run.runId, stageId);
    await store.ensureAttemptWorkspace(run.runId, stageId, 2);
    await store.appendStageEvent(run.runId, stageId, { event: "started" }, { attempt: 2 });
    await store.writeEnvelope(run.runId, stageId, envelopeAttempt2, { attempt: 2 });

    const snapshot = await buildStageSnapshotFromStore(
      store,
      run.runId,
      stageId,
      workspaceDir,
    );

    expect(snapshot.attempt_count).toBe(2);
    expect(snapshot.envelope).toEqual(envelopeAttempt2);
    expect(snapshot.status).toBe("running");
  });

  it("legacy no-execution-row snapshot", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });
    const workspaceDir = store.getWorkspaceDir(run.runId);

    await store.ensureStageWorkspace(run.runId, stageId);
    await store.appendStageEvent(run.runId, stageId, { event: "started" });
    await store.appendStageEvent(run.runId, stageId, { event: "succeeded" });

    const snapshot = await buildStageSnapshotFromStore(
      store,
      run.runId,
      stageId,
      workspaceDir,
    );

    expect(snapshot.attempt_count).toBe(1);
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.envelope).toBeNull();
  });

  it("countStageAttempts after two createStageExecution → 2", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });

    await store.createStageExecution(run.runId, stageId);
    await store.createStageExecution(run.runId, stageId);

    expect(await store.countStageAttempts(run.runId, stageId)).toBe(2);
  });

  it('appendStageEvent("succeeded") → snapshot status succeeded', async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });
    const workspaceDir = store.getWorkspaceDir(run.runId);

    await store.createStageExecution(run.runId, stageId);
    await store.appendStageEvent(run.runId, stageId, { event: "started" }, { attempt: 1 });
    await store.appendStageEvent(run.runId, stageId, { event: "succeeded" }, { attempt: 1 });

    const snapshot = await buildStageSnapshotFromStore(
      store,
      run.runId,
      stageId,
      workspaceDir,
    );

    expect(snapshot.status).toBe("succeeded");
  });

  it("layout: ensureAttemptWorkspace(1) creates attempts/1/.pi-agent/, no root .pi-agent/", async () => {
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: defaultTaskYaml,
    });
    const workspaceDir = store.getWorkspaceDir(run.runId);

    await store.ensureStageWorkspace(run.runId, stageId);
    await store.ensureAttemptWorkspace(run.runId, stageId, 1);

    await expect(
      access(attemptAgentDir(workspaceDir, stageId, 1)),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(workspaceDir, "stages", stageId, ".pi-agent")),
    ).rejects.toThrow();
  });

});
