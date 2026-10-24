import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import type { RunStore } from "../src/runstore/port.js";
import {
  applyPendingMigrations,
  CURRENT_SCHEMA_VERSION,
  type SqliteMigration,
} from "../src/runstore/sqlite/migrations/index.js";
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
import { EVAL_RUN_STATUSES } from "../src/evals/constants.js";
import { EvalStoreError } from "../src/evals/storeError.js";
import type { CreateEvalRunInput } from "../src/evals/storeTypes.js";

const MIGRATIONS_TO_14: SqliteMigration[] = [
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
  MIGRATION_007,
  MIGRATION_008,
  MIGRATION_009,
  MIGRATION_010,
  MIGRATION_011,
  MIGRATION_012,
  MIGRATION_013,
  MIGRATION_014,
];

async function openStore(): Promise<RunStore> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-evals-store-"));
  return createRunStore({ rootDir: root, kind: "sqlite" });
}

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

async function seedResults(store: RunStore, evalRunId: string): Promise<void> {
  await store.insertEvalCases(evalRunId, [
    { caseId: "c1", position: 0, case: { id: "c1", input: { a: 1 } } },
    { caseId: "c2", position: 1, case: { id: "c2", input: { a: 2 } } },
  ]);
  await store.upsertEvalResult({
    evalRunId,
    caseId: "c1",
    repeatIndex: 0,
    status: "completed",
    stageRunId: "run-c1-0",
    output: { status: "success", summary: "ok", payload: {}, artifacts: [] },
    score: 1,
    passed: true,
    grades: [{ graderId: "g1", graderType: "schema", status: "graded", passed: true, score: 1, rawValue: 1 }],
  });
  await store.upsertEvalResult({
    evalRunId,
    caseId: "c2",
    repeatIndex: 0,
    status: "completed",
    stageRunId: "run-c2-0",
    score: 0.2,
    passed: false,
    budgetWarnings: ["cost"],
    grades: [
      {
        graderId: "g1",
        graderType: "reference",
        status: "graded",
        passed: false,
        score: 0.2,
        rawValue: 0.2,
        details: { items: [{ text: "x", found: false }] },
      },
      { graderId: "g2", graderType: "rubric", status: "error", errorCode: "EVAL_JUDGE_ERROR" },
    ],
  });
}

describe("migration 015", () => {
  it("migrates a v14 database with data to current without losing rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-evals-migrate-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    applyPendingMigrations(db, { migrations: MIGRATIONS_TO_14 });
    expect(db.pragma("user_version", { simple: true })).toBe(14);
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
       VALUES ('keep-me', 'p', 'id: t', 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.close();

    const store = createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });
    const listed = await store.listRuns();
    expect(listed.map((r) => r.run_id)).toEqual(["keep-me"]);
    await store.close();

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(17);
    expect(after.prepare(`SELECT origin FROM runs WHERE run_id = 'keep-me'`).get()).toEqual({ origin: null });
    after.close();
  });

  it("a fresh store ends at current with every eval table, index and check constraint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-evals-fresh-"));
    createRunStore({ rootDir: root, kind: "sqlite" });
    const db = new Database(path.join(storeRootFor(root), "state.db"));
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master`).all() as Array<{
      type: string;
      name: string;
      sql: string | null;
    }>;
    const names = (type: string): string[] => objects.filter((o) => o.type === type).map((o) => o.name);
    expect(names("table")).toEqual(
      expect.arrayContaining([
        "eval_runs",
        "eval_run_counters",
        "eval_cases",
        "eval_results",
        "eval_grades",
        "eval_grader_versions",
        "eval_failure_types",
        "eval_result_reviews",
        "eval_result_tags",
      ]),
    );
    expect(names("index")).toEqual(
      expect.arrayContaining([
        "runs_origin",
        "eval_runs_number",
        "eval_runs_eval",
        "eval_runs_status",
        "eval_results_stage_run",
      ]),
    );
    const sqlOf = (name: string): string => objects.find((o) => o.name === name)?.sql ?? "";
    expect(sqlOf("eval_runs")).toContain("CHECK (target_kind IN ('stage','agent'))");
    expect(sqlOf("eval_runs")).toContain("'budget_stopped'");
    expect(sqlOf("eval_runs")).toContain("CHECK (started_via IN ('console','cli','mcp'))");
    expect(sqlOf("eval_results")).toContain("'skipped_budget'");
    expect(sqlOf("eval_grades")).toContain("CHECK (status IN ('graded','error'))");
    expect(sqlOf("eval_result_reviews")).toContain("CHECK (label IN ('pass','fail'))");
    expect(sqlOf("eval_failure_types")).toContain("COLLATE NOCASE");
    expect(sqlOf("eval_result_tags")).toContain("COLLATE NOCASE");
    expect(() =>
      db
        .prepare(
          `INSERT INTO eval_runs (eval_run_id, project_root, eval_id, run_number, eval_path, eval_hash, target_kind, target_ref_json,
            target_version_hash, dataset_path, dataset_hash, config_json, config_fingerprint, config_components_json, status, repeats,
            pass_threshold, max_cost_usd, cases_total, results_total, engine_name, engine_version, stageflow_version, started_via, created_at)
           VALUES ('x','/p','e',1,'p','h','stage','{}','h','d','h','{}','f','{}','nonsense',1,1,1,1,1,'e','1','1','cli','now')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});

describe("eval runs", () => {
  it("numbers runs per eval and project from 1 and never reuses a deleted number", async () => {
    const store = await openStore();
    const a1 = await store.createEvalRun(runInput());
    const a2 = await store.createEvalRun(runInput());
    const otherEval = await store.createEvalRun(runInput({ evalId: "other" }));
    const otherProject = await store.createEvalRun(runInput({ projectRoot: "/p/two" }));
    expect([a1.runNumber, a2.runNumber, otherEval.runNumber, otherProject.runNumber]).toEqual([1, 2, 1, 1]);
    expect(a1.evalRunId).toMatch(/^er_[0-9a-f]{12}$/);
    expect(a1.status).toBe("queued");

    await store.deleteEvalRun(a2.evalRunId);
    const a3 = await store.createEvalRun(runInput());
    expect(a3.runNumber).toBe(3);
    expect((await store.getEvalRunByNumber("/p/one", "triage", 2))).toBeNull();
    expect((await store.getEvalRunByNumber("/p/one", "triage", 3))?.evalRunId).toBe(a3.evalRunId);
  });

  it("round-trips JSON columns and updates progress and the final state", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput({ label: "first", callerId: "cli:1" }));
    expect(run.targetRef).toEqual({ pipeline_path: "pipelines/a.pipeline.yaml", stage_id: "classify" });
    expect(run.config).toEqual({ snapshot_version: 1 });
    expect(run.passed).toBeNull();
    expect(run.summary).toBeNull();

    await store.updateEvalRunProgress(run.evalRunId, {
      status: "running",
      startedAt: "2026-02-01T00:00:00.000Z",
      resultsDone: 2,
      costUsd: 0.5,
    });
    const running = await store.getEvalRun(run.evalRunId);
    expect(running).toMatchObject({ status: "running", resultsDone: 2, costUsd: 0.5, startedAt: "2026-02-01T00:00:00.000Z" });

    await store.finishEvalRun(run.evalRunId, {
      status: "budget_stopped",
      statusReason: "limit",
      passed: false,
      summary: { pass_rate: 0.5 },
      finishedAt: "2026-02-01T00:01:00.000Z",
    });
    const done = await store.getEvalRun(run.evalRunId);
    expect(done).toMatchObject({
      status: "budget_stopped",
      statusReason: "limit",
      passed: false,
      summary: { pass_rate: 0.5 },
      finishedAt: "2026-02-01T00:01:00.000Z",
    });
    await expect(store.finishEvalRun("er_missing", { status: "failed", passed: false, summary: {}, finishedAt: "x" })).rejects.toMatchObject({
      code: "EVAL_RUN_NOT_FOUND",
    });
    expect(EVAL_RUN_STATUSES).toContain(done!.status);
  });

  it("lists with filters, newest first, and pages with a cursor", async () => {
    vi.useFakeTimers();
    try {
      const store = await openStore();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i));
        ids.push((await store.createEvalRun(runInput({ evalId: i % 2 === 0 ? "even" : "odd" }))).evalRunId);
      }
      const first = await store.listEvalRuns({ limit: 2 });
      expect(first.items.map((r) => r.evalRunId)).toEqual([ids[4], ids[3]]);
      expect(first.nextCursor).not.toBeNull();
      const second = await store.listEvalRuns({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.map((r) => r.evalRunId)).toEqual([ids[2], ids[1]]);
      const third = await store.listEvalRuns({ limit: 2, cursor: second.nextCursor! });
      expect(third.items.map((r) => r.evalRunId)).toEqual([ids[0]]);
      expect(third.nextCursor).toBeNull();

      const even = await store.listEvalRuns({ evalId: "even", projectRoot: "/p/one", limit: 10 });
      expect(even.items).toHaveLength(3);
      expect((await store.listEvalRuns({ status: "running", limit: 10 })).items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("eval cases, results and grades", () => {
  it("stores cases and results with grades and reads them back typed", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await seedResults(store, run.evalRunId);

    expect((await store.getEvalCases(run.evalRunId)).map((c) => c.caseId)).toEqual(["c1", "c2"]);
    const results = await store.listEvalResults(run.evalRunId);
    expect(results.map((r) => [r.caseId, r.repeatIndex, r.passed])).toEqual([
      ["c1", 0, true],
      ["c2", 0, false],
    ]);
    expect(results[0]!.output).toEqual({ status: "success", summary: "ok", payload: {}, artifacts: [] });
    expect(results[1]!.budgetWarnings).toEqual(["cost"]);
    expect(results[1]!.grades.map((g) => g.graderId)).toEqual(["g1", "g2"]);
    expect(results[1]!.grades[0]!.details).toEqual({ items: [{ text: "x", found: false }] });
    expect(results[1]!.grades[1]).toMatchObject({ status: "error", passed: null, errorCode: "EVAL_JUDGE_ERROR" });

    const forCase = await store.getEvalResultsForCase(run.evalRunId, "c2");
    expect(forCase).toHaveLength(1);
    expect(forCase[0]!.grades).toHaveLength(2);
  });

  it("replaces grades when a result is upserted again", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await seedResults(store, run.evalRunId);
    await store.upsertEvalResult({
      evalRunId: run.evalRunId,
      caseId: "c2",
      repeatIndex: 0,
      status: "completed",
      score: 1,
      passed: true,
      grades: [{ graderId: "g1", graderType: "reference", status: "graded", passed: true, score: 1 }],
    });
    const [again] = await store.getEvalResultsForCase(run.evalRunId, "c2");
    expect(again!.passed).toBe(true);
    expect(again!.grades).toHaveLength(1);
  });

  it("rolls back the result when a grade insert fails", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await store.insertEvalCases(run.evalRunId, [{ caseId: "c1", position: 0, case: { id: "c1" } }]);
    await expect(
      store.upsertEvalResult({
        evalRunId: run.evalRunId,
        caseId: "c1",
        repeatIndex: 0,
        status: "completed",
        passed: true,
        grades: [
          { graderId: "g1", graderType: "schema", status: "graded", passed: true },
          { graderId: "g1", graderType: "schema", status: "graded", passed: true },
        ],
      }),
    ).rejects.toThrow();
    expect(await store.listEvalResults(run.evalRunId)).toEqual([]);

    await expect(
      store.upsertEvalResult({
        evalRunId: run.evalRunId,
        caseId: "c1",
        repeatIndex: 1,
        status: "completed",
        grades: [{ graderId: "g1", graderType: "schema", status: "bogus" as never }],
      }),
    ).rejects.toThrow(/CHECK/);
    expect(await store.listEvalResults(run.evalRunId)).toEqual([]);
  });

  it("rejects a result for a case that is not in the run", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await expect(
      store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "nope", repeatIndex: 0, status: "completed" }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("deletes an eval run with everything under it and returns the stage run ids", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    const keep = await store.createEvalRun(runInput({ evalId: "keep" }));
    await seedResults(store, run.evalRunId);
    await seedResults(store, keep.evalRunId);
    await store.putEvalReview(run.evalRunId, "c2", 0, { label: "fail", note: "n", tags: ["Missed"] });

    const stageRunIds = await store.deleteEvalRun(run.evalRunId);
    expect(stageRunIds).toEqual(["run-c1-0", "run-c2-0"]);
    expect(await store.getEvalRun(run.evalRunId)).toBeNull();
    expect(await store.getEvalCases(run.evalRunId)).toEqual([]);
    expect(await store.listEvalResults(run.evalRunId)).toEqual([]);
    expect(await store.getEvalReviews(run.evalRunId)).toEqual([]);
    expect(await store.listEvalResults(keep.evalRunId)).toHaveLength(2);
    await expect(store.deleteEvalRun(run.evalRunId)).rejects.toBeInstanceOf(EvalStoreError);
  });
});

describe("eval reviews and failure types", () => {
  it("accepts tags only on failed results", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await seedResults(store, run.evalRunId);

    await expect(store.putEvalReview(run.evalRunId, "c1", 0, { tags: ["Missed"] })).rejects.toMatchObject({
      code: "EVAL_TAGS_ON_PASSED_RESULT",
    });
    expect(await store.listFailureTypes("/p/one", "triage")).toEqual([]);

    const review = await store.putEvalReview(run.evalRunId, "c2", 0, {
      label: "fail",
      note: "wrong label",
      tags: ["Missed", "missed", "Hallucinated"],
    });
    expect(review).toMatchObject({ label: "fail", note: "wrong label", tags: ["Missed", "Hallucinated"] });
    expect(await store.getEvalReviews(run.evalRunId)).toEqual([review]);

    const label = await store.putEvalReview(run.evalRunId, "c1", 0, { label: "pass", tags: [] });
    expect(label).toMatchObject({ label: "pass", tags: [] });
  });

  it("replaces the tag set, keeps the note when omitted and rejects a note without a label", async () => {
    const store = await openStore();
    const run = await store.createEvalRun(runInput());
    await seedResults(store, run.evalRunId);

    await expect(store.putEvalReview(run.evalRunId, "c2", 0, { note: "n" })).rejects.toThrow(/label/);
    await store.putEvalReview(run.evalRunId, "c2", 0, { label: "fail", note: "why", tags: ["A", "B"] });
    const replaced = await store.putEvalReview(run.evalRunId, "c2", 0, { tags: ["b", "C"] });
    expect(replaced.tags.sort()).toEqual(["B", "C"]);
    expect(replaced).toMatchObject({ label: "fail", note: "why" });
    const noteOnly = await store.putEvalReview(run.evalRunId, "c2", 0, { note: null });
    expect(noteOnly.note).toBeNull();
    await expect(store.putEvalReview(run.evalRunId, "c2", 0, { tags: [" "] })).rejects.toThrow();
    await expect(store.putEvalReview(run.evalRunId, "c2", 0, { label: "fail", note: "x".repeat(501) })).rejects.toThrow();
    await expect(store.putEvalReview(run.evalRunId, "nope", 0, { label: "fail" })).rejects.toMatchObject({
      code: "EVAL_RUN_NOT_FOUND",
    });
  });

  it("orders the vocabulary by most recent use and matches names case-insensitively", async () => {
    vi.useFakeTimers();
    try {
      const store = await openStore();
      vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
      const run = await store.createEvalRun(runInput());
      await seedResults(store, run.evalRunId);
      await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: "c1", repeatIndex: 1, status: "error", passed: false });

      vi.setSystemTime(new Date("2026-03-01T00:00:01Z"));
      await store.putEvalReview(run.evalRunId, "c2", 0, { label: "fail", tags: ["Alpha"] });
      vi.setSystemTime(new Date("2026-03-01T00:00:02Z"));
      await store.putEvalReview(run.evalRunId, "c1", 1, { label: "fail", tags: ["Beta"] });
      expect(await store.listFailureTypes("/p/one", "triage")).toEqual(["Beta", "Alpha"]);

      vi.setSystemTime(new Date("2026-03-01T00:00:03Z"));
      await store.putEvalReview(run.evalRunId, "c1", 1, { tags: ["Beta", "alpha"] });
      expect(await store.listFailureTypes("/p/one", "triage")).toEqual(["Alpha", "Beta"]);
      expect(await store.listFailureTypes("/p/one", "other")).toEqual([]);
      expect(await store.listFailureTypes("/p/two", "triage")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("grader versions", () => {
  it("gives ordinals in order of first sight and the same ordinal for a repeated hash", async () => {
    const store = await openStore();
    expect(await store.recordGraderVersions("/p/one", "triage", [{ graderId: "tone", graderHash: "a" }])).toEqual({ tone: 1 });
    expect(await store.recordGraderVersions("/p/one", "triage", [{ graderId: "tone", graderHash: "b" }])).toEqual({ tone: 2 });
    expect(await store.recordGraderVersions("/p/one", "triage", [{ graderId: "tone", graderHash: "c" }])).toEqual({ tone: 3 });
    expect(
      await store.recordGraderVersions("/p/one", "triage", [
        { graderId: "tone", graderHash: "a" },
        { graderId: "shape", graderHash: "z" },
      ]),
    ).toEqual({ tone: 1, shape: 1 });
    expect(await store.recordGraderVersions("/p/one", "other", [{ graderId: "tone", graderHash: "q" }])).toEqual({ tone: 1 });
  });
});

describe("runs.origin filter", () => {
  async function seedRuns(store: RunStore): Promise<{ normal: string; eval: string }> {
    const normal = await store.createRun({ pipelineId: "p", taskYaml: "id: t\n" });
    const evalRun = await store.createRun({ pipelineId: "p", taskYaml: "id: t\n", origin: "eval" });
    return { normal: normal.runId, eval: evalRun.runId };
  }

  it("hides eval stage runs by default and shows them for any or eval", async () => {
    const store = await openStore();
    const ids = await seedRuns(store);
    expect((await store.listRuns()).map((r) => r.run_id)).toEqual([ids.normal]);
    expect((await store.listRuns({})).map((r) => r.run_id)).toEqual([ids.normal]);
    expect((await store.listRuns({ status: "running" })).map((r) => r.run_id)).toEqual([ids.normal]);
    expect((await store.listRuns({ origin: "any" })).map((r) => r.run_id).sort()).toEqual([ids.eval, ids.normal].sort());
    expect((await store.listRuns({ origin: "eval" })).map((r) => r.run_id)).toEqual([ids.eval]);
    expect((await store.listRuns()).length).toBe(1);
  });

  it("keeps an eval stage run readable by id and marks its meta", async () => {
    const store = await openStore();
    const ids = await seedRuns(store);
    expect((await store.readRun(ids.eval)).run_id).toBe(ids.eval);
    expect((await store.readRunMeta(ids.eval)).origin).toBe("eval");
    expect((await store.readRunMeta(ids.normal)).origin).toBeUndefined();
    await store.deleteRun(ids.eval);
    expect((await store.listRuns({ origin: "any" })).map((r) => r.run_id)).toEqual([ids.normal]);
  });

  it("excludes eval stage runs from the overview rows", async () => {
    const store = await openStore();
    const ids = await seedRuns(store);
    const rows = await store.listRunOverviewRows("2000-01-01T00:00:00.000Z");
    expect(rows.map((r) => r.run_id)).toEqual([ids.normal]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
