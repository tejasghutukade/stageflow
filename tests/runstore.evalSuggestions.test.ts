import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
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
import { MIGRATION_016 } from "../src/runstore/sqlite/migrations/016-eval-subject-ref.js";
import { MIGRATION_017 } from "../src/runstore/sqlite/migrations/017-eval-result-suggestions.js";
import type { SuggestionInput } from "../src/evals/triage/types.js";

const UP_TO_16 = [
  MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007, MIGRATION_008,
  MIGRATION_009, MIGRATION_010, MIGRATION_011, MIGRATION_012, MIGRATION_013, MIGRATION_014, MIGRATION_015, MIGRATION_016,
];

const input = (caseId: string, overrides: Partial<SuggestionInput> = {}): SuggestionInput => ({
  caseId,
  repeatIndex: 0,
  source: "jev",
  bucket: "agent_wrong",
  failureType: "tone",
  confidence: 0.9,
  bucketProbabilities: { agent_wrong: 0.9, grader_wrong: 0.1, case_wrong: 0, unclear: 0 },
  graderFalseAlarms: [{ graderId: "g", probability: 0.2 }],
  model: "jev-1.13.0",
  promptVersion: 1,
  batchId: "sb_1",
  costUsd: 0.01,
  stateTruncated: false,
  ...overrides,
});

describe("migration 017 and suggestion rows", () => {
  it("upgrades a v16 database, round-trips suggestions and cascades on run delete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-suggestions-store-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    applyPendingMigrations(db, { migrations: UP_TO_16 });
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    db.close();

    const store = createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });
    const project = await store.ensureProject(await mkdtemp(path.join(tmpdir(), "sf-suggestions-proj-")));
    const run = await store.createEvalRun({
      projectRoot: project, evalId: "e", evalPath: "e.yaml", evalHash: "h", targetKind: "stage", targetRef: {},
      targetVersionHash: "h", datasetPath: "d", datasetHash: "h", config: {}, configFingerprint: "f", configComponents: {},
      repeats: 1, passThreshold: 0.8, maxCostUsd: 1, casesTotal: 2, resultsTotal: 2, engineName: "fake", engineVersion: "1",
      stageflowVersion: "1", startedVia: "cli",
    });
    await store.insertEvalCases(run.evalRunId, [
      { caseId: "c1", position: 0, case: { id: "c1" } },
      { caseId: "c2", position: 1, case: { id: "c2" } },
    ]);
    for (const id of ["c1", "c2"]) {
      await store.upsertEvalResult({ evalRunId: run.evalRunId, caseId: id, repeatIndex: 0, status: "completed", passed: false });
    }

    const first = await store.upsertEvalSuggestions(run.evalRunId, [input("c1"), input("c2", { bucket: "unclear", failureType: null })]);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ caseId: "c1", status: "pending", graderFalseAlarms: [{ graderId: "g", probability: 0.2 }], costUsd: 0.01 });
    expect(first[1]).toMatchObject({ bucket: "unclear", failureType: null });

    const [c1] = first;
    expect(await store.acceptEvalSuggestions(run.evalRunId, [c1!.id])).toEqual({ accepted: 1, tagged: 1 });
    const replaced = await store.upsertEvalSuggestions(run.evalRunId, [input("c1", { bucket: "case_wrong" }), input("c2", { bucket: "case_wrong" })]);
    expect(replaced.map((r) => r.caseId)).toEqual(["c2"]);
    const all = await store.listEvalSuggestions(run.evalRunId);
    expect(all.map((r) => [r.caseId, r.bucket, r.status])).toEqual([
      ["c1", "agent_wrong", "accepted"],
      ["c2", "case_wrong", "pending"],
    ]);
    expect((await store.getEvalReviews(run.evalRunId))[0]?.tags).toEqual(["tone", "bucket:agent_wrong"]);

    await store.deleteEvalRun(run.evalRunId);
    expect(await store.listEvalSuggestions(run.evalRunId)).toEqual([]);
    await store.close();

    const after = new Database(dbPath);
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATION_017.version);
    expect(after.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    after.close();
  });
});
