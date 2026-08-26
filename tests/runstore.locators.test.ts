import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";

describe("run store locators", () => {
  it("persists and reads all locator fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-"));
    const store = createRunStore({ rootDir: root });
    const pipelinePath = path.resolve("/abs/pipeline.yaml");
    const taskPath = path.resolve("/abs/task.yaml");
    const projectRoot = path.resolve("/abs/project");

    const run = await store.createRun({
      pipelineId: "demo",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelinePath,
      taskPath,
      projectRoot,
    });

    const meta = await store.readRunMeta(run.runId);
    expect(meta.pipeline_path).toBe(pipelinePath);
    expect(meta.task_path).toBe(taskPath);
    expect(meta.project_root).toBe(projectRoot);
  });

  it("omits locators when not provided on create", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-null-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const meta = await store.readRunMeta(run.runId);
    expect(meta.pipeline_path).toBeUndefined();
    expect(meta.task_path).toBeUndefined();
    expect(meta.project_root).toBeUndefined();
  });

  it("migrates existing databases idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-migrate-"));
    const dbPath = path.join(root, "state.db");
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
VALUES ('legacy-1', 'docs-only', 'id: t\ngoal: g\n', 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
`);
    db.close();

    const store1 = new SqliteRunStore(root);
    await store1.ready();
    const meta1 = await store1.readRunMeta("legacy-1");
    expect(meta1.pipeline_path).toBeUndefined();

    const store2 = new SqliteRunStore(root);
    await store2.ready();
    const meta2 = await store2.readRunMeta("legacy-1");
    expect(meta2.pipeline_path).toBeUndefined();

    const cols = new Database(dbPath)
      .prepare(`PRAGMA table_info(runs)`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("pipeline_path");
    expect(names).toContain("task_path");
    expect(names).toContain("project_root");
  });
});
