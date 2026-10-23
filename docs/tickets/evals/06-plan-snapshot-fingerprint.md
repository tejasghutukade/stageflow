# 06: EvalPlan, config snapshot and fingerprint

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** 02, 03

## Why this story exists

Before a run starts, everything that determines it must be resolved once into a plan (what the engine executes) and a snapshot (what is stored with the run). One function does this for the console, CLI and MCP, applying overrides, case selection, skipping, limits and validation the same way each time.

## Read first

- [engine-interface.md](../../specs/evals-engine-interface.md): `EvalPlan`.
- [result-schema.md](../../specs/evals-result-schema.md): "Config snapshot", fingerprint, `config_components_json`.
- [eval-file-schema.md](../../specs/evals-file-schema.md): Defaults, "How a case becomes a task", findings.
- Stories 02 and 03 outputs (`loadEvalOutcome`, `resolveEvalTarget`, `validateEval`, `loadDatasetFile`, `checkDatasetAgainstStage`, `canonicalJson`).
- `src/package-meta.ts` (`PACKAGE_VERSION`).

## Decisions already made (do not revisit)

- Overrides allowed at run start: `repeats`, `judge`, `model`, `max_cost_usd`, and a case selection (`case_ids` or `tags` or `only_failed_from`, mutually exclusive). Nothing else.
- Cases whose input fails the stage's `io.input.schema` are **skipped** (not run); their ids go to `dataset.skipped_case_ids`. If none remain: error `eval.no_valid_cases`.
- Limits P11 are enforced here: `repeats` 1–10, `concurrency` 1–8, results ≤ 5,000, with `EVAL_INVALID` and the matching finding.
- The fingerprint, components and snapshot shapes are exactly as in result-schema.md.
- `judge_same_as_stage` in the snapshot compares the effective judge with the effective stage model (after the `model` override).

## What to build

0. **Types:** add `EvalPlan`, `PlanCase` and `ResolvedGrader` (if story 02 has not) to `src/evals/types.ts` exactly as in [engine-interface.md](../../specs/evals-engine-interface.md).
1. **`src/evals/plan.ts`:** `buildEvalPlan(input)` where `input = { projectRoot, evalPath, overrides, evalRunId, caseSelection resolver deps (a function giving the failed case ids of a past run), engine: { name, version, nodeVersion }, graderOrdinals?: Record<string, number>, now }` returns either `{ ok: true, plan, snapshot, fingerprint, components, skippedCaseIds, findings }` or `{ ok: false, findings }` (errors only block; warnings are returned).
   - Loads the eval, resolves the target, loads the dataset, validates (story 02's `validateEval` with the dataset report), applies overrides, selects cases (file order preserved, case ids unknown to the dataset are an error `EVAL_INVALID`), skips invalid cases, builds `EvalPlan` and `ResolvedGrader[]` with the effective judge filled into rubric graders that have none.
2. **`src/evals/snapshot.ts`:** `buildSnapshot(...)`, `computeFingerprint(...)`, `buildComponents(...)` per result-schema.md. Uses `canonicalJson`; the fingerprint is the first 8 hex of sha256.
3. **`src/evals/caseTask.ts`:** `caseToTask(plan, case, evalRunId, repeatIndex)` per "How a case becomes a task" (used by story 08).
4. Export `RUBRIC_PROMPT_VERSION` from a constants file (`src/evals/constants.ts`, created by story 04) with value `1`; the engine story owns the prompt text.

## Acceptance

- [ ] A fixture eval + dataset + stage yields a plan whose cases, graders and settings match the file; defaults are applied (repeats 3, threshold 0.8, concurrency 4, max cost 2).
- [ ] Each override changes the plan and appears under `snapshot.overrides` and `snapshot.settings`; an unknown case id errors.
- [ ] `tags` selection picks cases with any listed tag; `only_failed_from` uses the supplied resolver; mutually exclusive selections error.
- [ ] A dataset with 2 invalid cases of 24 gives 22 plan cases, `cases_skipped = 2`, their ids in the snapshot, and a `eval.cases_skipped` warning; a dataset of only invalid cases gives `eval.no_valid_cases`.
- [ ] `repeats = 11`, `concurrency = 9`, or results > 5,000 each return an error finding and no plan.
- [ ] The fingerprint is stable for identical inputs, changes when each of these changes (stage prompt, dataset case, a grader's rubric text, judge, repeats, threshold, engine version, rubric prompt version, case subset), and does **not** change when `max_cost_usd`, `concurrency`, `label` or Stageflow version changes (one test per item).
- [ ] `components` lists each fingerprint input so two snapshots can be diffed by key.
- [ ] `caseToTask` follows the goal fallback chain and omits absent optional fields.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Starting runs, persisting, engines, HTTP.

## Open questions

_(agent fills; stop and ask the owner)_
