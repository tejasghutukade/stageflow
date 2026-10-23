# 09: EvalRunManager

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 04, 05, 06, 07, 08

## Why this story exists

Something must own an eval run's lifecycle: validate and plan it, record it, drive the engine, persist each result as it arrives, enforce the budget and cancel, finish with statistics, and survive a Host restart. That is the `EvalRunManager`. It is engine-agnostic (tested with `FakeEngine`) and transport-agnostic (the API, CLI and MCP all call it).

## Read first

- [Epic](../../specs/evals.md): Architecture steps 1–6, P9.
- [engine-interface.md](../../specs/evals-engine-interface.md) ("Rules"), [result-schema.md](../../specs/evals-result-schema.md) (all: statuses, scoring, `summary_json`).
- Outputs of stories 04–08 (`RunStore` eval methods, `computeStats`/`scoreResult`, `buildEvalPlan`, `EvalEngine`/`FakeEngine`, `createStageCaseRunner`).
- Where the Host constructs `RunManager` and shares dependencies with routes and MCP: `src/server/bootstrap.ts`, `src/server/http.ts` (search for where `manager` and `store` are created and passed to `handleTriggerRoutes`), `src/mcp/deps.ts` (`McpToolDeps`). Boot-time recovery precedent: `reenqueuePersistedQueuedRuns` and the interrupted-run handling in `src/runtime/runManager.ts`.

## Decisions already made (do not revisit)

- **One eval run at a time per Host** (P9): `start` while another is `queued` or `running` throws `EVAL_RUN_ACTIVE`. "Try one case" is also refused while an eval run is active, and an eval run is refused while a try is active.
- The engine emits raw grades; **the manager** computes `score`, `passed`, `has_grader_errors` and `budget_warnings` with `scoreResult` (story 05) and persists each result **immediately** in one transaction.
- Statuses follow result-schema.md. `passed` is set only for `completed` runs with `pass_rate ≥ pass_threshold`.
- On cancel: stop the engine (abort signal), `runner.cancelAll`, mark every (case, repeat) never emitted as result status `cancelled`; run status `cancelled`.
- On budget exhaustion: the runner starts refusing new cases; the engine emits those as `skipped_budget`; the manager marks any never-emitted remainder `skipped_budget` and sets run status `budget_stopped` with reason "Reached the $X cost limit".
- Judge cost counts toward the budget through `io.reportJudgeCost`; when spend ≥ limit the manager flips the runner into refusal mode.
- Engine crash or `EVAL_ENGINE_UNAVAILABLE` → status `failed` with the error's message (no secrets); partial results are kept.
- **Boot recovery:** on Host start, every eval run still `queued` or `running` becomes `failed` with reason "Host stopped while the run was in progress", its un-emitted results are not created (they simply do not exist; the UI treats the run as incomplete), and its active stage runs are left to the existing run recovery.
- Statistics are not stored per result; at finish the manager stores `summary_json` = the headline numbers of `computeStats` (pass rate and CI, results executed/passed/errored, reliability, mean score, cost total, latency p50, flaky count).

## What to build

1. **`src/evals/manager.ts`:** `class EvalRunManager` constructed with `{ store, stageRunner, engines (registry getEngine), stageflowVersion, now, logger, workDirRoot }`. Methods:
   - `start({ projectRoot, evalPath, overrides, startedVia, callerId?, label? })` → `{ evalRunId, runNumber }`: build the plan (story 06), reject on error findings with `EVAL_INVALID` carrying the findings, record grader versions (ordinals) and fill the snapshot, create the run row (`queued`), then start the engine **asynchronously** (the call returns once the row exists) and move to `running`.
   - `cancel(evalRunId)`, `getLive(evalRunId)` (the in-memory phase list), `activeRunId()`, `tryOne({ projectRoot, definition|evalPath, case|caseId })` → runs the plan with one case and one repeat through the same engine and runner, **persists nothing**, returns `{ result, grades, stageRunId, costUsd }`.
   - `awaitFinished(evalRunId, timeoutMs)` for the CLI/MCP wait modes.
   - `recoverOnBoot()`.
2. **Wiring:** construct the manager where the Host builds its services, call `recoverOnBoot()` on boot, and expose it to route and MCP dependencies (`McpToolDeps`).
3. **Progress:** after each persisted result update `results_done` and `cost_usd` on the run row.
4. **Finish:** compute stats from the store, set `summary_json`, `passed`, final status, `finished_at`; remove the engine work directory unless `STAGEFLOW_EVALS_KEEP_WORKDIR=1`.
5. Tests with `FakeEngine` and a fake stage runner (no real runs): full success (statuses, rows, ordinals, `run_number`), pass/fail result scoring through the manager, budget stop mid-run, cancel mid-run, engine failure, second start while active → `EVAL_RUN_ACTIVE`, `tryOne` persisting nothing, boot recovery, `awaitFinished` timeout.

## Acceptance

- [ ] A 4-case × 2-repeat fake run produces 8 result rows with grades, `results_done = 8`, correct per-result `score`/`passed`, a `summary_json`, status `completed`, `passed` consistent with the threshold.
- [ ] `run_number` is 1 for the first run of an eval and 2 for the next; grader version ordinals follow story 04 behavior across runs after a grader's rubric text changes.
- [ ] A budget of $0.05 with $0.02 per case ends `budget_stopped` with some results `completed` and the rest `skipped_budget`; `passed = 0`.
- [ ] `cancel` mid-run ends `cancelled`, in-flight stage runs are cancelled, undone results are `cancelled`.
- [ ] `start` while a run is active throws `EVAL_RUN_ACTIVE`; after it finishes `start` works.
- [ ] An invalid eval (error findings) throws `EVAL_INVALID` with the findings and creates no row.
- [ ] An engine that throws leaves status `failed`, keeps already persisted results, and the stored reason contains no stack trace.
- [ ] `recoverOnBoot` converts `queued`/`running` runs to `failed`.
- [ ] `tryOne` returns grades and cost, creates no `eval_*` rows, and is refused while a run is active.
- [ ] Results are persisted as they arrive (a test reads the store between `onResult` calls).
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

HTTP, CLI, MCP, UI. The promptfoo engine.

## Open questions

_(agent fills; stop and ask the owner)_
