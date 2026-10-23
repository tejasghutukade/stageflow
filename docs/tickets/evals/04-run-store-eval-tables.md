# 04: Run store: eval tables and `runs.origin`

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** none

## Why this story exists

Eval runs, results, grades and reviews need storage, and stage runs started by evals must be marked and hidden from normal run views (P2). The schema is fixed in [result-schema.md](../../specs/evals-result-schema.md). This story adds the migration, the store methods, and the `origin` filter.

## Read first

- [result-schema.md](../../specs/evals-result-schema.md): "Tables", "Statuses", "Error codes". Copy the DDL from there; do not redesign it.
- `src/runstore/sqlite/migrations/014-agent-deliveries.ts` and `index.ts` (how a migration is declared and registered), `src/runstore/sqlite/schema.ts`, `src/runstore/sqlite/SqliteRunStore.ts`, `src/runstore/port.ts` (the `RunStore` interface; `ListRunsFilter`; `RunSummary`), `src/runstore/createStore.ts`.
- The call-site list recorded by story 00 (item 12) of every place runs are listed or counted for display. If story 00 has not run, derive the list yourself with `grep -rn "listRuns" src` and record it in this story's final note.
- Tests: `tests/runstore.*.test.ts` (find the pattern for migration and store tests, including how tests open a temp store).

## Decisions already made (do not revisit)

- `runs.origin TEXT` (`NULL` normal, `'eval'` for eval stage runs). Eval stage runs have no `caller_id`.
- The eval tables and columns are exactly those in result-schema.md, including `run_number` (unique per eval, never reused) and `details_json`.
- **Eval stage runs are hidden by default** from: the Runs list, Inbox, Overview summary, sidebar counts, catalog usage stats, `sf runs list`, MCP `list_runs`. They remain readable by id everywhere (run detail pages and `sf runs show <id>` work). A new filter value makes them visible.
- Retention: the existing sweep treats eval stage runs like any run (result-schema "Retention").

## What to build

1. **Migration `015-evals.ts`** (`MIGRATION_015`, `version: 15`, `name: "015_evals"`): `ALTER TABLE runs ADD COLUMN origin`, the index, and all eval tables and indexes from result-schema.md. Register it in `migrations/index.ts`. Add a test that a database at version 14 with data migrates to 15 without data loss and that a fresh database ends at 15 with all tables.
2. **Store port + SQLite implementation** for eval data. Add to the `RunStore` port (and implement in `SqliteRunStore.ts`; add trivial implementations to any other class that implements `RunStore`, such as in-memory test stores):
   - `createEvalRun(input): Promise<EvalRunRow>` allocating `run_number` atomically (`MAX+1` per eval inside a transaction; never reuse after deletes: keep a per-eval counter in a small `eval_run_counters` table instead of `MAX+1` if `MAX+1` could reuse a deleted number; add that table to the migration if you choose it and say so in the final note).
   - `insertEvalCases(evalRunId, cases)`, `upsertEvalResult(result + grades)` (one transaction per result: result row and its grade rows), `updateEvalRunProgress(evalRunId, { results_done, cost_usd, status?, ... })`, `finishEvalRun(evalRunId, { status, status_reason, passed, summary_json, finished_at })`.
   - Reads: `getEvalRun(id)`, `getEvalRunByNumber(projectRoot, evalId, n)`, `listEvalRuns({ projectRoot?, evalId?, status?, limit, cursor })`, `listEvalResults(evalRunId)` (all rows with grades; the stats module takes these), `getEvalResultsForCase(evalRunId, caseId)`, `getEvalCases(evalRunId)`.
   - Reviews and tags: `putEvalReview(evalRunId, caseId, repeat, { label?, note?, tags? })` (enforcing "tags only on results with `passed = 0`"), `getEvalReviews(evalRunId)`, failure-type vocabulary `listFailureTypes(projectRoot, evalId)` ordered by most recent use, new names inserted on first use.
   - Grader versions: `recordGraderVersions(projectRoot, evalId, graders[])` returning `{ graderId → ordinal }` (inserts unseen hashes with the next ordinal per grader id).
   - `deleteEvalRun(evalRunId)` returning the stage run ids it started (the caller deletes those runs through the existing run deletion path).
   - Marks: `startRun` options gain `origin?: "eval"` stored on the `runs` row (the manager change is story 08; this story adds the column and the store write path for run creation).
3. **`origin` filter:** `ListRunsFilter` gains `origin?: "eval" | "any"`; default (undefined) excludes `origin = 'eval'`. Update every call site from the list so default behavior hides eval runs; add the explicit `any` where a caller needs all (retention sweep, disk usage, run deletion by id, GC). Add tests proving: a normal list omits eval runs, `origin: "any"` includes them, `readRun(id)` still works for an eval run, run counts exclude them.
4. **Types:** row types in `src/evals/storeTypes.ts` (camelCase TS ↔ snake_case columns, JSON columns parsed to typed objects).
5. **Statuses and codes** as TypeScript string unions and constants in `src/evals/constants.ts` (statuses, error codes, limits P11) so every later story imports them.

## Acceptance

- [ ] Migration 15 applies to fresh and existing stores; every table, index and check constraint in result-schema.md exists (a test reads `sqlite_master`).
- [ ] `run_number` increments per eval from 1, is independent across evals and projects, and is not reused after `deleteEvalRun` of the latest run (test).
- [ ] Inserting a result with its grades is atomic: a failing grade insert rolls back the result (test).
- [ ] Deleting an eval run cascades to cases, results, grades, reviews and tags and returns the stage run ids.
- [ ] `putEvalReview` rejects tags for a result with `passed = 1` and accepts them for `passed = 0`; new tags appear in the vocabulary ordered by recent use; matching is case-insensitive.
- [ ] `recordGraderVersions` gives ordinals 1, 2, 3 in order of first sight and returns the same ordinal for a repeated hash.
- [ ] Default run listing hides eval stage runs everywhere on the call-site list; each call site has a test or is covered by a listed test; `origin: "any"` shows them.
- [ ] `npm test` and `npm run typecheck` pass; no existing test changed except to account for the new default filter, and each such change is listed in the final note.

## Out of scope

Computing statistics (story 05). Starting eval stage runs (story 08). Any API or UI.

## Open questions

_(agent fills; stop and ask the owner)_
