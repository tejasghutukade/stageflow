import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunStore,
  DISK_STORE_REJECTED,
} from "../src/runstore/createStore.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { plantDiskEraRun } from "./helpers/plantDiskEraRun.js";

describe("sqlite run store", () => {
  it("persists runs, events, and envelopes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
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
    expect(detail.stages[0]?.envelope?.summary).toBe("ok");
    expect(detail.task_yaml).toContain("goal: g");

    const listed = await store.listRuns();
    expect(listed.some((r) => r.run_id === run.runId)).toBe(true);

    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBeUndefined();
  });

  it("persists checkout_root on create and returns it from readRunMeta", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-co-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      checkoutRoot: checkout,
    });
    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBe(checkout);
  });

  it("adds stage_events.attempt via ALTER on legacy DB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-attempt-alter-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE stages (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  envelope_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, stage_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE TABLE stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
`);
    legacy.close();

    createRunStore({ rootDir: root, kind: "sqlite" });

    const probe = new Database(dbPath);
    const cols = probe.prepare(`PRAGMA table_info(stage_events)`).all() as {
      name: string;
    }[];
    probe.close();
    expect(cols.some((c) => c.name === "attempt")).toBe(true);
  });

  it("adds checkout_root via ALTER on existing DB missing the column", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-alter-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE stages (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  envelope_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, stage_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE TABLE stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
`);
    legacy.close();

    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      checkoutRoot: checkout,
    });
    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBe(checkout);

    const probe = new Database(dbPath);
    const cols = probe.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    probe.close();
    expect(cols.some((c) => c.name === "checkout_root")).toBe(true);
  });

  it("rejects kind disk and SF_STORE=disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reject-disk-"));
    expect(() => createRunStore({ rootDir: root, kind: "disk" })).toThrow(
      DISK_STORE_REJECTED,
    );

    const prev = process.env.SF_STORE;
    process.env.SF_STORE = "disk";
    try {
      expect(() => createRunStore({ rootDir: root })).toThrow(DISK_STORE_REJECTED);
    } finally {
      if (prev === undefined) delete process.env.SF_STORE;
      else process.env.SF_STORE = prev;
    }
  });

  it("imports existing disk runs when sqlite db is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-"));
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
    const detail = await sqlite.readRun(runId);
    expect(detail.task_id).toBe("legacy");
    expect(detail.stages[0]?.envelope?.summary).toBe("from disk");
    expect(detail.status).toBe("succeeded");
    const meta = await sqlite.readRunMeta(runId);
    expect(meta.checkout_root).toBe(checkout);
  });

  it("does not re-import when sqlite already has rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate2-"));
    const sqlite = createRunStore({ rootDir: root, kind: "sqlite" });
    await sqlite.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: only\ngoal: db\n",
      taskId: "only",
    });

    const oldDir = path.join(storeRootFor(root), "runs", "should-not-import");
    await mkdir(oldDir, { recursive: true });
    await writeFile(
      path.join(oldDir, "meta.json"),
      `${JSON.stringify({
        run_id: "should-not-import",
        pipeline_id: "docs-only",
        created_at: "2020-01-01T00:00:00.000Z",
        status: "succeeded",
      }, null, 2)}\n`,
    );
    await writeFile(path.join(oldDir, "task.copy.yaml"), "id: skip\ngoal: no\n");

    const again = createRunStore({ rootDir: root, kind: "sqlite" });
    if (again instanceof SqliteRunStore) {
      await again.ready();
    }
    const runs = await again.listRuns();
    expect(runs.some((r) => r.run_id === "should-not-import")).toBe(false);
    expect(runs.some((r) => r.task_id === "only")).toBe(true);
  });

  it("derives waiting_for_input and keeps run running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-wait-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const waiting = await store.readRun(run.runId);
    expect(waiting.stages[0]?.status).toBe("waiting_for_input");
    expect(waiting.status).toBe("running");

    await store.appendStageEvent(run.runId, "clarify", { event: "resumed" });
    const resumed = await store.readRun(run.runId);
    expect(resumed.stages[0]?.status).toBe("running");
    expect(resumed.status).toBe("running");
  });

  it("listRuns includes waiting fields while a stage waits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-list-wait-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: wait\n",
      taskId: "t",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "operator_prompt",
      prompt: {
        kind: "confirm",
        id: "prompt-1",
        message: "Accept this plan?",
      },
    });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const listed = await store.listRuns();
    const row = listed.find((r) => r.run_id === run.runId);
    expect(row?.status).toBe("running");
    expect(row?.waiting_stage_id).toBe("clarify");
    expect(row?.waiting_summary).toBe("Accept this plan?");
    expect(row?.waiting_kind).toBe("confirm");
    expect(row?.waiting_prompt_id).toBe("prompt-1");
    expect(row?.stages).toEqual([
      { id: "clarify", status: "waiting_for_input", attempt_count: 1 },
    ]);
    expect(row?.failed_stage_id).toBeUndefined();

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("running");
    expect(detail.waiting_stage_id).toBe("clarify");
    expect(detail.waiting_summary).toBe("Accept this plan?");
    expect(detail.waiting_kind).toBe("confirm");
    expect(detail.waiting_prompt_id).toBe("prompt-1");
    expect(detail.failed_stage_id).toBeUndefined();

    await store.appendStageEvent(run.runId, "clarify", {
      event: "operator_answer",
      promptId: "prompt-1",
      answer: { kind: "confirm", decision: "accept" },
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
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-list-fail-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
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

  it("handles concurrent writers from separate connections without SQLITE_BUSY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-concurrent-"));
    const primary = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await primary.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const writerA = createRunStore({ rootDir: root, kind: "sqlite" });
    const writerB = createRunStore({ rootDir: root, kind: "sqlite" });
    const writerC = createRunStore({ rootDir: root, kind: "sqlite" });

    await Promise.all([
      writerA.appendStageEvent(run.runId, "branch-a", { event: "started" }),
      writerB.appendStageEvent(run.runId, "branch-b", { event: "started" }),
      writerC.appendStageEvent(run.runId, "branch-c", { event: "started" }),
    ]);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([
          writerA.appendStageEvent(run.runId, "branch-a", {
            event: "message",
            role: "assistant",
            text: `a-${i}`,
          }),
          writerB.appendStageEvent(run.runId, "branch-b", {
            event: "message",
            role: "assistant",
            text: `b-${i}`,
          }),
          writerC.appendStageEvent(run.runId, "branch-c", {
            event: "message",
            role: "assistant",
            text: `c-${i}`,
          }),
        ]),
      ),
    );

    const detail = await primary.readRun(run.runId);
    const byStage = Object.fromEntries(
      detail.stages.map((s) => [s.stage_id, s.events.length]),
    );
    expect(byStage["branch-a"]).toBe(11);
    expect(byStage["branch-b"]).toBe(11);
    expect(byStage["branch-c"]).toBe(11);
  });
});
