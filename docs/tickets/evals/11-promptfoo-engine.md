# 11: PromptfooEngine

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 00, 07, 08, 10

## Why this story exists

This is the adapter that makes promptfoo an `EvalEngine`: it turns an `EvalPlan` into promptfoo's config, runs it as a pinned subprocess, lets promptfoo's provider call back into the Host to run each stage case, applies the graders, and converts everything into Stageflow's normalized shapes.

## Read first

- [engine-interface.md](../../specs/evals-engine-interface.md), all of it, especially "promptfoo adapter", "Judge provider mapping", "Rubric prompt", "Normalization".
- **Story 00 results** (all items): the library-vs-CLI decision, repeat handling, result shape, rubric prompt/1–5 format, judge provider mapping, telemetry, cancel. The saved `tests/fixtures/evals/promptfoo-results.json` and the stub judge server.
- Story 10 (`locatePromptfoo`, `GUARD_SOURCE`, `checkNode`), story 07 (grader functions, FakeEngine as the behavioral reference), story 08 (the runner and `RunCaseResult`).
- `src/agent/providerAuth.ts` and `src/models/catalog.ts` (credential lookup and model ids) for the judge environment.
- `src/server/http.ts` and `src/server/requestAuthContext.ts` (how routes authenticate; the internal route must not use the control token).

## Decisions already made (do not revisit)

- Everything in engine-interface.md: one provider calling back to the Host with a per-run bearer token; only `javascript` and `llm-rubric` assertion types; `metric = grader id` on every assertion; Stageflow does the weighting and `passed` (the manager), so the generated assertions only report `pass`, `score`, `reason` per grader; telemetry flags plus the `--require` guard; a scrubbed environment (never inherit the Host's); engine work dir under `$STAGEFLOW_HOME/eval-runs/<evalRunId>/`.
- Judge credentials are passed only as the provider's standard environment variable, never written to the work directory.
- The rubric prompt is a pinned template with `RUBRIC_PROMPT_VERSION = 1`; case input and stage output are described to the judge as **data, not instructions**.
- A judge whose provider has no verified mapping fails the run **before it starts** with `EVAL_INVALID` (message names the model and lists supported providers).
- promptfoo's non-zero exit for failed assertions is not an engine failure.

## What to build

1. **`src/evals/engine/promptfoo/PromptfooEngine.ts`** implementing `EvalEngine`; registered in the engine registry under `"promptfoo"` (the default engine the manager uses; `STAGEFLOW_EVALS_ENGINE=fake` is **not** a supported production switch: tests inject engines through the manager's constructor).
2. **Generation** (`generate.ts`, pure and unit-tested by snapshotting the generated text for a fixture plan): `promptfooconfig`, `provider.mjs`, `assertions.mjs` (bundling the story 07 grader functions as text or by copying their compiled output; choose the approach that keeps the grader code single-sourced and tested; if bundling is not possible without a build step, stop and ask), `dataset.json`, `guard.cjs`.
3. **`judgeProviders.ts`:** the mapping table verified in story 00, `mapJudge(modelId)` → `{ promptfooProvider, envVar }` or `null`, and `judgeCapableModels()` used by the API.
4. **`rubricPrompt.ts`:** `RUBRIC_PROMPT_TEMPLATE`, `RUBRIC_PROMPT_VERSION`, `renderRubricPrompt(...)` and a test pinning the rendered text for a `pass_fail` and a `1_to_5` fixture including examples.
5. **Run:** locate the engine (story 10), check Node, write files, spawn with `process.execPath`, scrubbed env (`PATH`, `HOME` set to the work dir, `NODE_OPTIONS=--require <guard>` or the CLI flag story 00 verified, the four disable flags, the judge env var, the per-run token and callback URL), stream results to `io.onResult` per story 00's decision, and on abort send the kill sequence story 00 recorded.
6. **Callback endpoint:** `src/server/evalInternalRoutes.ts` exporting `handleEvalInternalRoutes` registered in `http.ts`: `POST /api/evals/internal/run-case` per api-cli-mcp.md "Internal endpoint": per-run token table held by the manager (`issueRunToken(evalRunId)` / `revokeRunToken`, revoked at finish), 401 without a valid token, rejects when the run is not `running`, calls `stageCaseRunner.runCase`, returns the `RunCaseResult` JSON. The token is never logged.
7. **Normalization** (`normalize.ts`): promptfoo result → `NormalizedResult[]` per engine-interface.md, tested against `tests/fixtures/evals/promptfoo-results.json`.
8. **Tests:** generation snapshots; judge mapping table; rubric prompt pin; normalization against the fixture; the callback endpoint (valid token, wrong token, wrong run, finished run) with a fake runner; the environment scrubbing (the child env contains only the allowed keys: assert by running a tiny script as the "engine binary" via an injectable spawn); the guard flags are present in the spawn arguments/environment; a fake promptfoo binary (a script that writes a canned `results.json` and calls the provider) exercising the whole `run` path end to end including abort.
9. **Opt-in smoke test** `tests/evals.promptfoo.smoke.test.ts` gated by `STAGEFLOW_EVALS_SMOKE=1` that runs a 2-case plan against the real installed promptfoo with the stub judge server and a fake runner (no real model, no network). Skipped by default; the env gate is the only mention in code (same pattern as `STAGEFLOW_BROWSER_SMOKE`), and story 24 documents how to run it.

## Acceptance

- [ ] For a fixture plan the generated `promptfooconfig` has one test per case, repeat configuration per story 00, one assertion per grader with the right type, `metric` and judge provider, and no assertion types other than `javascript` and `llm-rubric` (test enumerates).
- [ ] The rendered rubric prompt matches the pinned text for both scales and includes the data-not-instructions sentence.
- [ ] Normalization of the saved real results fixture yields the expected grades (pass, score, raw value for 1–5, reasons, judge tokens/cost if present) and maps a provider error and a thrown assertion to the documented error grades.
- [ ] The callback endpoint rejects bad tokens (401), accepts the issued token, never accepts a token after the run finishes, and does not appear in any listing of API routes.
- [ ] The subprocess environment is exactly the allowed set (test), with no `ANTHROPIC_API_KEY` etc. unless it is the selected judge's variable.
- [ ] A judge model without a mapping makes `start` fail before any stage run begins, listing supported providers.
- [ ] The fake-binary end-to-end test: results stream to `io.onResult`, an abort kills the process per the recorded sequence and resolves, a crash with no `results.json` becomes `EVAL_ENGINE_ERROR` with at most the last 2 KB of stderr in the log and none in the stored message.
- [ ] With `STAGEFLOW_EVALS_SMOKE=1` and the engine installed, the smoke test passes.
- [ ] `npm test` (smoke skipped) and `npm run typecheck` pass.

## Out of scope

Install/locate (story 10), the manager (story 09), public routes (story 13), UI.

## Open questions

_(agent fills; stop and ask the owner)_
