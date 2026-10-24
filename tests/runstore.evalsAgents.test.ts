import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import type { RunStore } from "../src/runstore/port.js";
import { applyPendingMigrations, CURRENT_SCHEMA_VERSION } from "../src/runstore/sqlite/migrations/index.js";
import { MIGRATION_001 } from "../src/runstore/sqlite/migrations/001-baseline.js";
import { MIGRATION_002 } from "../src/runstore/sqlite/migrations/002-repository-binding.js";
import { MIGRATION_003 } from "../src/runstore/sqlite/migrations/003-run-lifecycle.js";
import { MIGRATION_004 } from "../src/runstore/sqlite/migrations/004-auto-resume-count.js";
import { MIGRATION_005 } from "../src/runstore/sqlite/migrations/005-config-origins.js";
import { MIGRATION_006 } from "../src/runstore/sqlite/migrations/006-pipeline-body-and-caller.js";
import { MIGRATION_007 } from "../src/runstore/sqlite/migrations/007-projects-registry.js";
import { MIGRATION_008 } from "../src/runstore/sqlite/migrations/008-triggers-table.js";
import { MIGRATION_009 } from "../src/runstore/sqlite/migrations/009-trigger-next-run.js";
import { MIGRATION_010 } from "../src/runstore/sqlite/migrations/010-trigger-adapter-state.js";
import { MIGRATION_011 } from "../src/runstore/sqlite/migrations/011-email-dispatch-key.js";
import { MIGRATION_012 } from "../src/runstore/sqlite/migrations/012-trigger-fires.js";
import { MIGRATION_013 } from "../src/runstore/sqlite/migrations/013-agents.js";
import { MIGRATION_014 } from "../src/runstore/sqlite/migrations/014-agent-deliveries.js";
import { MIGRATION_015 } from "../src/runstore/sqlite/migrations/015-evals.js";
import type { CreateEvalRunInput } from "../src/evals/storeTypes.js";

const MIGRATIONS_TO_15 = [
  MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007,
  MIGRATION_008, MIGRATION_009, MIGRATION_010, MIGRATION_011, MIGRATION_012, MIGRATION_013, MIGRATION_014,
  MIGRATION_015,
];

function runInput(overrides: Partial<CreateEvalRunInput> = {}): CreateEvalRunInput {
  return {
    projectRoot: "/p/one",
    evalId: "triage",
    evalPath: "evals/triage.eval.yaml",
    evalHash: "h-eval",
    targetKind: "stage",
    targetRef: { pipeline_path: "pipelines/a.pipeline.yaml", stage_id: "classify" },
    targetVersionHash: "h-stage",
    datasetPath: "datasets/t.dataset.jsonl",
    datasetHash: "h-data",
    config: { snapshot_version: 1 },
    configFingerprint: "abcd1234",
    configComponents: { stage: "h-stage" },
    repeats: 2,
    passThreshold: 0.8,
    maxCostUsd: 2,
    casesTotal: 2,
    resultsTotal: 4,
    engineName: "fake",
    engineVersion: "1",
    stageflowVersion: "0.38.0",
    startedVia: "cli",
    ...overrides,
  };
}

async function openStore(): Promise<RunStore> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-evals-agents-store-"));
  return createRunStore({ rootDir: root, kind: "sqlite" });
}

describe("migration 016", () => {
  it("upgrades a v15 database with eval data and backfills subject_ref", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-evals-migrate16-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    applyPendingMigrations(db, { migrations: MIGRATIONS_TO_15 });
    expect(db.pragma("user_version", { simple: true })).toBe(15);
    db.prepare(
      `INSERT INTO eval_runs (eval_run_id, project_root, eval_id, run_number, eval_path, eval_hash, target_kind, target_ref_json,
        target_version_hash, dataset_path, dataset_hash, config_json, config_fingerprint, config_components_json, status, repeats,
        pass_threshold, max_cost_usd, cases_total, results_total, engine_name, engine_version, stageflow_version, started_via, created_at)
       VALUES ('er_1','/p','e',1,'p','h','stage','{}','h','d','h','{}','f','{}','completed',1,1,1,1,2,'e','1','1','cli','now')`,
    ).run();
    db.prepare(`INSERT INTO eval_cases (eval_run_id, case_id, position, case_json) VALUES ('er_1','c1',0,'{}')`).run();
    db.prepare(
      `INSERT INTO eval_results (eval_run_id, case_id, repeat_index, status, stage_run_id) VALUES ('er_1','c1',0,'completed','run-1')`,
    ).run();
    db.prepare(
      `INSERT INTO eval_results (eval_run_id, case_id, repeat_index, status) VALUES ('er_1','c1',1,'skipped_budget')`,
    ).run();
    db.close();

    const store = createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });
    await store.listRuns();
    await store.close();

    const after = new Database(dbPath);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    expect(after.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const cols = (after.prepare(`PRAGMA table_info(eval_results)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["subject_ref", "turns", "tool_call_count"]));
    expect(
      after.prepare(`SELECT repeat_index, stage_run_id, subject_ref, turns, tool_call_count FROM eval_results ORDER BY repeat_index`).all(),
    ).toEqual([
      { repeat_index: 0, stage_run_id: "run-1", subject_ref: "run-1", turns: null, tool_call_count: null },
      { repeat_index: 1, stage_run_id: null, subject_ref: null, turns: null, tool_call_count: null },
    ]);
    const indexes = (after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain("eval_results_subject_ref");
    after.close();
  });
});

describe("agent eval results in the store", () => {
  it("stage results default subjectRef to the stage run id", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await store.insertEvalCases(run.evalRunId, [{ caseId: "c1", position: 0, case: { id: "c1" } }]);
    await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c1", repeatIndex: 0, status: "completed", stageRunId: "run-1" });
    const [row] = await store.listEvalResults(run.evalRunId);
    expect(row).toMatchObject({ stageRunId: "run-1", subjectRef: "run-1", turns: null, toolCallCount: null });
    expect(await store.listEvalSubjectRefs(run.evalRunId, "stage")).toEqual(["run-1"]);
    expect(await store.listEvalSubjectRefs(run.evalRunId, "agent")).toEqual([]);
  });

  it("round-trips an agent result, lists session refs and keeps deleteEvalRun to stage ids", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(
      runInput({ targetKind: "agent", targetRef: { agent_id: "support" }, evalId: "support-basics" }),
    );
    await store.insertEvalCases(run.evalRunId, [
      { caseId: "c1", position: 0, case: { id: "c1" } },
      { caseId: "c2", position: 1, case: { id: "c2" } },
    ]);
    await store.upsertEvalResult({
      evalRunId: run.evalRunId, caseId: "c1", repeatIndex: 0, status: "completed",
      subjectRef: "sess-1", turns: 3, toolCallCount: 2,
    });
    await store.upsertEvalResult({
      evalRunId: run.evalRunId, caseId: "c2", repeatIndex: 0, status: "stage_failed", errorCode: "EVAL_AGENT_FAILED",
      subjectRef: "sess-2",
    });
    await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c2", repeatIndex: 1, status: "error" });

    const rows = await store.listEvalResults(run.evalRunId);
    expect(rows[0]).toMatchObject({ caseId: "c1", stageRunId: null, subjectRef: "sess-1", turns: 3, toolCallCount: 2 });
    expect(rows[1]).toMatchObject({ caseId: "c2", repeatIndex: 0, subjectRef: "sess-2", turns: null });
    expect(await store.listEvalSubjectRefs(run.evalRunId, "agent")).toEqual(["sess-1", "sess-2"]);
    expect(await store.listEvalSubjectRefs(run.evalRunId, "stage")).toEqual([]);
    expect((await store.listEvalRuns({ subjectRef: "sess-2", limit: 10 })).items.map((r) => r.evalRunId)).toEqual([run.evalRunId]);
    expect((await store.listEvalRuns({ subjectRef: "nope", limit: 10 })).items).toEqual([]);

    expect(await store.deleteEvalRun(run.evalRunId)).toEqual([]);
  });
});
