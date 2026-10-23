# 05: Stats module (pure)

**Epic:** [Evals](../../specs/evals.md) · **Status:** ready-for-agent · **Blocked by:** none

## Why this story exists

Every number on the results, list and compare pages comes from one pure module, so numbers cannot disagree between the API, CLI and UI, and the statistics (clustered intervals, pass^k, paired compare) are tested once against hand-computed values (A11).

## Read first

- [result-schema.md](../../specs/evals-result-schema.md): "Scoring", "Statistics", "Compare", "List status", "Cost estimate". These are the formulas; implement them exactly. Do not substitute other interval methods.
- [eval-file-schema.md](../../specs/evals-file-schema.md): grader pass rules (the per-grader `passed` rules are in result-schema "Scoring" step 5).

## Decisions already made (do not revisit)

All formulas, tables of t quantiles, nearest-rank percentiles, definitions of executed/counted results, the treatment of errored and skipped results, the verdict rules and the list-status rules are in result-schema.md. No third-party statistics library; the t table is a constant.

## What to build

All in `src/evals/`, **pure functions, no I/O, no clock reads (take `now` as input where needed)**:

1. `scoring.ts`: `scoreResult({ graders, grades, passThreshold, status, latencyMs, costUsd, budget })` → `{ score, passed, hasGraderErrors, budgetWarnings }` implementing the five steps of "Scoring" (including the must-pass rules, grader errors, and the no-scored-graders case).
2. `stats.ts`: `computeStats(input)` where `input = { results: ResultRecord[], grades: GradeRecord[], graders: {id,type,hash}[], repeats, passThreshold, reviewsTags?: Map<resultKey, string[]>, previousRun?: { stats-lite per grader: { graderId, hash, passRate } } }` → the `Stats` object with every field in the statistics table: counts, `pass_rate`, `pass_rate_ci`, `mean_score`, `score_spread`, `reliability`, `pass_any`, `flaky_cases`, latency percentiles, costs, tokens, `by_grader` (with `delta`), `score_histogram`, `failure_types`, `failing_cases`. Define `ResultRecord` and `GradeRecord` in `src/evals/storeTypes.ts` if story 04 has not (they mirror the table rows; story 04 owns the final shape, so import from it when present).
3. `tTable.ts`: the 30-entry quantile table and `tQuantile(df)`.
4. `compare.ts`: `compareRuns(a, b)` per "Compare", including shared cases, paired clustered CI, verdict, per-case change and `graders_changed`, per-grader deltas, deltas of cost/latency/flaky/mean score, components diff, warnings, `sd_d` and `cases_needed_5pts`. `stage_diff` is built by `stageDiff.ts`.
5. `stageDiff.ts` + `lineDiff.ts`: `lineDiff(a: string, b: string)` returns `[{ op: "same"|"add"|"remove", text }]` using a standard longest-common-subsequence line diff (write it; no dependency); `stageDiff(defA, defB)` returns `{ changed_keys: string[], system_prompt_diff: DiffLine[] | null }` where `changed_keys` lists top-level keys of the stage definition JSON whose canonical JSON differs, plus `io.input` / `io.output` as separate entries when `io` differs (compare `io.input` and `io.output` individually).
6. `listStatus.ts`: `listStatus(completedRunsNewestFirst, type)` and `regressionBanner(evals)` per "List status".
7. `estimate.ts`: `estimateRun(input)` implementing "Cost estimate" (inputs: results_total, rubric grader count, previous run summary or null, recent stage costs array, previous wall time).
8. `format-free`: this module returns raw numbers (fractions 0–1, dollars, ms). All display formatting belongs to the UI (`ui/src/redesign/evals/format.ts`).

## Acceptance

- [ ] The two worked examples in result-schema.md reproduce exactly (CI to 3 decimals, reliability, pass@k, flaky list).
- [ ] `tQuantile(1) = 12.706`, `tQuantile(30) = 2.042`, `tQuantile(31) = 1.96`, `tQuantile(0)` throws.
- [ ] `computeStats` handles: zero executed results (all rates `null`, no throw), one case (CI `null`), repeats = 1 (`reliability` and `pass_any` null), skipped/cancelled results excluded, errored counted as failed, missing latency/cost tolerated.
- [ ] Scoring tests cover: all pass; one must-pass fails; scored grader error excluded from mean and flagged; must-pass grader error fails the result; no scored graders; weights; `1_to_5` normalization (raw 4 → 0.75) and `pass_at`; budget warnings; non-completed result has null score.
- [ ] Percentiles use nearest-rank as defined (test with 1, 2, 5 and 20 values).
- [ ] `compareRuns`: identical runs → d̄ = 0, verdict `no_clear_difference` (or `insufficient_data` when m < 5); a clear improvement over ≥ 5 cases → `improved`; different datasets → only shared cases used and a warning; different grader hash → listed as `changed` with no delta; `cases_needed_5pts` computed from a hand-checked fixture.
- [ ] `lineDiff` tests: identical, pure add, pure remove, replace, empty strings, trailing newline differences. `stageDiff` reports `system_prompt` and `io.output` changes separately.
- [ ] `listStatus` covers all five statuses and the banner's `criteria_dropped` rule (≤ −5 points, same grader hash only).
- [ ] No test touches the store, files, the network or the clock.
- [ ] `npm test` and `npm run typecheck` pass.

## Out of scope

Reading from the store, HTTP, UI formatting, the engine.

## Open questions

_(agent fills; stop and ask the owner)_
