# 08: Host stage case runner

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 00, 04, 06

## Why this story exists

An eval result is a real stage run (P2). This story is the code that turns one (case, repeat) into a stage run, waits for it, and returns the envelope, latency, cost and tokens, while enforcing the budget and supporting cancel.

## Read first

- [engine-interface.md](../../specs/evals-engine-interface.md): "Host stage case runner" (steps 1–7) and the types.
- **The epic's "Pre-build verification results"** (story 00 items 10, 11, 13). They are authoritative for: how to wait, where envelope/latency/usage come from, what a gate-stop and a failure look like, and how capacity queuing behaves. If they are missing, stop.
- `src/mcp/catalogTools.ts` (`run_stage` tool, the code that builds the inline pipeline, calls `manager.startRun`, and blocks), `src/a2a/service.ts` (around line 299, the same flow), `src/runtime/runManager.ts` (`startRun` signature and result, cancel), `src/config/materializeStageModels.ts`, `src/runtime/taskInput.ts`.
- Story 06's `caseToTask`, `EvalPlan` and `PlanCase` types, story 04's `origin` column and constants.

## Decisions already made (do not revisit)

- The pipeline is `{ id: "standalone-<stageId>", stages: [<inline stage body>] }` as `run_stage` builds it; the stage body carries the **materialized model**; a plan `modelOverride` replaces `model`.
- `origin: "eval"` marks the run; `caller_id` is not set.
- A stage that stops for input → cancel the run → `EVAL_STAGE_NEEDS_INPUT` (P7). Safety timeout per epic P15: stage `timeout_ms` + 60 s (30 min when unset), then cancel the stage run and return `EVAL_STAGE_TIMEOUT` (story 00 found the manager does not enforce `timeout_ms`).
- Stage failure maps to `EVAL_STAGE_FAILED`; a stage timeout to `EVAL_STAGE_TIMEOUT`; Host/engine faults to `EVAL_ENGINE_ERROR`. Messages carry the existing failure reason text, never secrets.
- Latency = stage `finished_at − started_at` of the single stage. Cost and tokens = the stage usage the store records.
- Budget: the runner refuses to **start** a case once spend ≥ `maxCostUsd` (`EVAL_BUDGET_EXCEEDED`); in-flight cases finish and their cost is added (so the limit can be exceeded by up to `concurrency` cases; document this in the run dialog's "stops at" copy through the spec, not here).
- Capacity: queued runs wait; the runner does not poll faster than the mechanism story 00 recorded.

## What to build

1. **`StartRunOptions.origin`** on `RunManager.startRun` (`"eval"`), threaded to the store write that creates the run (story 04 added the column). Normal callers pass nothing.
2. **`src/evals/runner/stageCaseRunner.ts`:** `createStageCaseRunner(deps)` returning `{ runCase(plan, req): Promise<RunCaseResult>, cancelAll(evalRunId): Promise<void>, spend(evalRunId): number, addSpend(evalRunId, usd): void }`. Keeps per-eval-run in-memory state: active stage run ids and spend.
   - Builds the inline stage body: pipeline form: stage from the loaded pipeline with materialized model (reuse `loadPipeline` + `materializeStageModels`; do not re-implement model resolution); file form: load the stage file, materialize with the manifest model.
   - Starts via `manager.startRun`, waits per story 00's finding, converts the final stage envelope to `CaseOutput`, reads usage, and returns `RunCaseResult`.
   - On `EVAL_STAGE_NEEDS_INPUT` cancels the run and waits until it is terminal before returning.
   - `cancelAll` cancels every active stage run of the eval run through the normal cancel path and resolves when all are terminal.
3. **Plan support for ephemeral try-runs:** the runner works from an `EvalPlan` object passed in, and must not need the store to know the eval run (so story 09 can run "try one case" with a plan that is never persisted).
4. Tests with the repo's fake-agent harness (find how `tests/` drive `RunManager` with a fake stage worker/agent): success with usage; stage failure; timeout; gate stop; capacity queue (two cases with `maxConcurrent: 1` run one after the other); cancelAll; budget refusal; model override reaches the stage body; the run row has `origin = 'eval'` and no `caller_id`; the default run list does not show it.

## Acceptance

- [ ] A successful case returns `ok: true` with `stageRunId`, `output` (status, summary, payload, artifacts), `latencyMs`, `costUsd`, `tokensIn`, `tokensOut` from the fake agent's reported usage.
- [ ] Failure, timeout, gate stop and engine fault map to the documented codes with the stage run id when one exists.
- [ ] A gate-stopped stage run is cancelled and terminal before `runCase` resolves.
- [ ] Spend accumulates; once ≥ limit the next `runCase` returns `EVAL_BUDGET_EXCEEDED` without starting a run (assert the manager's run count).
- [ ] `cancelAll` cancels in-flight stage runs and they end `cancelled`.
- [ ] Model override: the started stage body's `model` equals the override; without it, the materialized model.
- [ ] Eval stage runs are invisible in the default run list and visible with `origin: "any"` (covered by story 04; here assert via the manager's store).
- [ ] No change in behavior for non-eval `startRun` callers (existing tests pass untouched).
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

The manager lifecycle and persistence (story 09); the HTTP callback endpoint (story 11 wires it); judge calls.

## Open questions

_(agent fills; stop and ask the owner)_
