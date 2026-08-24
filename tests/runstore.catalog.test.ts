import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  deriveStatusFromStages,
  stageStatusFromEvents,
} from "../src/runstore/port.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { plantDiskEraRun } from "./helpers/plantDiskEraRun.js";

describe("runstore catalog", () => {
  it("lists runs newest first with derived status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-"));
    await plantDiskEraRun(root, {
      runId: "old-run",
      pipelineId: "docs-only",
      taskYaml: "id: legacy\ngoal: old\n",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const store = createRunStore({ rootDir: root });
    if (store instanceof SqliteRunStore) {
      await store.ready();
    }
    const a = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t1\ngoal: first\n",
      taskId: "t1",
    });
    await store.appendStageEvent(a.runId, "clarify", { event: "started" });
    await store.appendStageEvent(a.runId, "clarify", { event: "succeeded" });
    await store.createStageExecution(a.runId, "clarify");
    await store.writeEnvelope(a.runId, "clarify", {
      status: "success",
      summary: "ok",
      artifacts: [],
    });

    const runs = await store.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]?.created_at >= runs[1]!.created_at).toBe(true);

    const old = runs.find((r) => r.run_id === "old-run");
    expect(old?.task_id).toBe("legacy");
    expect(old?.status).toBe("created");

    const newer = runs.find((r) => r.run_id === a.runId);
    expect(newer?.task_id).toBe("t1");
    expect(newer?.status).toBe("succeeded");
  });

  it("listRuns skips a malformed run directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-malformed-"));
    await plantDiskEraRun(root, {
      runId: "good-run",
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: ok\n",
      taskId: "t",
    });
    const badDir = path.join(storeRootFor(root), "runs", "broken-run");
    await mkdir(badDir, { recursive: true });
    const store = createRunStore({ rootDir: root });
    if (store instanceof SqliteRunStore) {
      await store.ready();
    }

    const runs = await store.listRuns();
    expect(runs.some((r) => r.run_id === "good-run")).toBe(true);
    expect(runs.some((r) => r.run_id === "broken-run")).toBe(false);
  });

  it("readRun returns stages, envelopes, and task yaml", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: demo\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "failed",
      reason: "boom",
    });

    const detail = await store.readRun(run.runId);
    expect(detail.task_yaml).toContain("goal: demo");
    expect(detail.stages).toHaveLength(1);
    expect(detail.stages[0]?.status).toBe("failed");
    expect(detail.status).toBe("failed");
  });

  it("deriveStatusFromStages covers created/running/succeeded/failed", () => {
    expect(deriveStatusFromStages([])).toBe("created");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "pending",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("created");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "running",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("running");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
        {
          stage_id: "b",
          status: "pending",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("running");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("succeeded");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "failed",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("failed");
  });

  it("stageStatusFromEvents derives waiting_for_input and resumed", () => {
    expect(
      stageStatusFromEvents([
        { event: "started" },
        { event: "waiting_for_input" },
      ]),
    ).toBe("waiting_for_input");
    expect(
      stageStatusFromEvents([
        { event: "started" },
        { event: "waiting_for_input" },
        { event: "resumed" },
      ]),
    ).toBe("running");
    expect(
      stageStatusFromEvents([
        { event: "started" },
        { event: "agent_start" },
        { event: "tool_start", toolName: "ask" },
        { event: "waiting_for_input" },
        { event: "message", role: "assistant", text: "hi" },
      ]),
    ).toBe("waiting_for_input");
    expect(
      stageStatusFromEvents([
        { event: "started" },
        { event: "waiting_for_input" },
        { event: "failed", reason: "boom" },
      ]),
    ).toBe("failed");
  });

  it("deriveStatusFromStages keeps run running while a stage waits", () => {
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("running");
    expect(
      deriveStatusFromStages([
        {
          stage_id: "a",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
        {
          stage_id: "b",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
        },
      ]),
    ).toBe("running");
  });

  it("listRuns includes waiting fields while a stage waits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-list-wait-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "operator_prompt",
      prompt: {
        kind: "free_text",
        id: "prompt-1",
        message: "What should the module name be?",
      },
    });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const listed = await store.listRuns();
    const row = listed.find((r) => r.run_id === run.runId);
    expect(row?.status).toBe("running");
    expect(row?.waiting_stage_id).toBe("clarify");
    expect(row?.waiting_summary).toBe("What should the module name be?");
    expect(row?.waiting_kind).toBe("free_text");
    expect(row?.waiting_prompt_id).toBe("prompt-1");
    expect(row?.stages).toEqual([
      { id: "clarify", status: "waiting_for_input", attempt_count: 1 },
    ]);
    expect(row?.failed_stage_id).toBeUndefined();

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("running");
    expect(detail.waiting_stage_id).toBe("clarify");
    expect(detail.waiting_summary).toBe("What should the module name be?");
    expect(detail.waiting_kind).toBe("free_text");
    expect(detail.waiting_prompt_id).toBe("prompt-1");
    expect(detail.failed_stage_id).toBeUndefined();

    await store.appendStageEvent(run.runId, "clarify", {
      event: "operator_answer",
      promptId: "prompt-1",
      answer: { kind: "free_text", text: "payments" },
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });

    const after = await store.listRuns();
    const cleared = after.find((r) => r.run_id === run.runId);
    expect(cleared?.waiting_stage_id).toBeUndefined();
    expect(cleared?.waiting_summary).toBeUndefined();
    expect(cleared?.waiting_kind).toBeUndefined();
    expect(cleared?.waiting_prompt_id).toBeUndefined();
    expect(cleared?.stages).toEqual([
      { id: "clarify", status: "running", attempt_count: 1 },
    ]);

    const afterDetail = await store.readRun(run.runId);
    expect(afterDetail.waiting_stage_id).toBeUndefined();
    expect(afterDetail.waiting_summary).toBeUndefined();
    expect(afterDetail.waiting_kind).toBeUndefined();
    expect(afterDetail.waiting_prompt_id).toBeUndefined();
  });

  it("listRuns includes compact stages and failed fields after a stage fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-list-fail-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: fail\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "implement", { event: "started" });
    await store.appendStageEvent(run.runId, "implement", {
      event: "failed",
      reason: "envelope payload failed schema",
    });

    const listed = await store.listRuns();
    const row = listed.find((r) => r.run_id === run.runId);
    expect(row?.status).toBe("failed");
    expect(row?.failed_stage_id).toBe("implement");
    expect(row?.failed_reason).toBe("envelope payload failed schema");
    expect(row?.waiting_stage_id).toBeUndefined();
    expect(row?.stages).toEqual([
      { id: "clarify", status: "running", attempt_count: 1 },
      { id: "implement", status: "failed", attempt_count: 1 },
    ]);

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(detail.failed_stage_id).toBe("implement");
    expect(detail.failed_reason).toBe("envelope payload failed schema");
    expect(detail.waiting_stage_id).toBeUndefined();
  });

  it("readRun derives waiting_for_input from durable stage events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-wait-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const detail = await store.readRun(run.runId);
    expect(detail.stages[0]?.status).toBe("waiting_for_input");
    expect(detail.status).toBe("running");

    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });
    const resumed = await store.readRun(run.runId);
    expect(resumed.stages[0]?.status).toBe("running");
    expect(resumed.status).toBe("running");
  });

  it("tolerates status updates via store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cat-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.updateRunStatus(run.runId, "succeeded");
    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("succeeded");
  });
});
