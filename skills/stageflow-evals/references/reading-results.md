# Reading results

How to read a finished eval run and a comparison. Every number below is computed by the server and returned on the run or the compare payload. Quote those fields. Do not recompute a rate, an interval, a reliability, a delta, or a verdict from the raw results.

## Contents

- The run headline
- Outcome and exit code
- Stats
- What the headline numbers mean
- Result statuses
- Graders, scores, and errors
- Compare
- List status

## The run headline

`sf eval run <id> --json` waits for the run and prints this object. It is not the full stats.

| Field | Meaning |
|---|---|
| `outcome` | `passed`, `below_threshold`, `failed`, `cancelled`, or `budget_stopped` |
| `eval_run_id` | The run id (`er_` plus 12 hex characters). Use it for show, compare, sort, and suggestions |
| `eval_id` | The eval |
| `pass_rate` | From stats. `null` when nothing executed |
| `pass_rate_ci` | `{ low, high }` or `null`. A 95% interval |
| `threshold` | `pass_threshold` from the run snapshot |
| `results.executed` | Results that ran |
| `results.passed` | Of those, how many passed |
| `results.errored` | Of those, how many have status `error` |
| `reliability` | Share of cases that passed on every repeat, or `null` when repeats is 1 or no case executed twice |
| `cost_total` | Stage or agent cost plus judge cost |
| `fingerprint` | Identity of the setup that produced this run |
| `url` | Console link for this run |

Agent runs add `target_kind`, `agent_id`, `agent_revision`, `mean_turns`, `mean_tool_calls`, and `tools_policy`.

The full object, including per-grader stats, is `sf eval runs show <evalRunId> --json`. Read `stats` there. `sf eval runs --json` lists headlines only.

## Outcome and exit code

`outcome` is derived from the run status and the `passed` flag:

| `outcome` | When | Exit |
|---|---|---|
| `passed` | Status `completed` and `pass_rate` is at least `pass_threshold` | 0 |
| `below_threshold` | Status `completed` and the pass rate is under the threshold | 1 |
| `budget_stopped` | Spending reached `max_cost_usd`. Completed results are kept. The run does not pass, even if the finished slice is above the threshold | 1 |
| `cancelled` | The run was stopped | 1 |
| `failed` | The run did not complete (engine crash, save error, or it stopped after repeated provider failures) | 1 |

Exit 1 with one of those outcomes is a finished report. Read `status_reason` on `sf eval runs show` when the outcome is `failed` or `budget_stopped`.

`passed` on the run is true only for a `completed` run whose pass rate meets the threshold. `budget_stopped` stores `passed: false`.

## Stats

`stats` on the run detail is the only place these live. The fields:

| Field | What it is |
|---|---|
| `cases_counted` | Cases with at least one executed result |
| `results_executed` | Results whose status is `completed`, `stage_failed`, `needs_input`, or `error` |
| `results_passed` | Executed results with `passed` true |
| `errored` | Executed results whose status is `error` |
| `pass_rate` | `results_passed / results_executed`, or `null` |
| `pass_rate_ci` | 95% interval that treats **cases** as the independent units. Repeats of one case are not extra evidence |
| `mean_score` | Mean score of `completed` results that have a score |
| `score_spread` | How much a case's score varies across its repeats |
| `reliability` | Share of cases that passed on every repeat. `null` when `repeats` is 1 or no case has two executed results. This is the number to quote when the user needs the stage or agent to work each time |
| `pass_any` | Share of cases that passed on at least one repeat. `null` in the same situations as `reliability`. It overstates how dependable the target is |
| `flaky_cases` | Case ids that passed on some repeats and failed on others |
| `latency_p50`, `latency_p95`, `latency_max` | Over `completed` results |
| `cost_stage`, `cost_judge`, `cost_total` | Target cost, judge cost, and the sum |
| `cost_per_result` | `cost_total / results_executed` |
| `tokens_in`, `tokens_out` | Target tokens |
| `judge_tokens_in`, `judge_tokens_out` | Judge tokens |
| `by_grader` | One row per grader: `pass_rate`, `mean_raw`, `min_raw`, `max_raw`, `errors`, `delta`, `grader_changed` |
| `failing_cases` | Cases that did not pass every executed repeat |
| `failure_types` | Counts of review tags on results that did not pass. Tags exist only after a person (or an accepted suggestion) wrote them |
| `mean_turns`, `mean_tool_calls` | Agent runs |

`by_grader[].delta` is the change in that grader's pass rate against the previous completed run, in percentage points, and only when the grader's definition hash matches. `grader_changed: true` means the definition changed, so the two runs are not comparable on that grader and `delta` is null.

`lowest_cases_by_grader` on the run detail (not inside `stats`) lists, per grader, up to five cases with the lowest mean grade score.

A model with no known price counts as $0 and the run says judge cost is unknown. Do not fill in a price.

## What the headline numbers mean

Say this in plain words, using the printed values:

- The pass rate is passed results over executed results. The interval treats cases, not repeats, as the evidence, so a handful of cases stays wide. Quote `pass_rate_ci` as printed.
- Reliability answers "did it pass every time we tried this case". Pass-at-least-once (`pass_any`) answers "can it pass on a good try".
- Flaky cases are noise if you only look at one repeat. Name the ids in `flaky_cases`.
- `errored` is not "everything that failed". A stage that crashed (`stage_failed`) or stopped at a gate (`needs_input`) lowers the pass rate and is **not** included in `errored`. `errored` is only status `error` (engine miss, empty agent reply, simulator failure).

## Result statuses

| Status | In the pass rate? | Typical cause |
|---|---|---|
| `completed` | Yes, pass or fail by its score and `must_pass` graders | The case finished and was graded |
| `stage_failed` | Yes, as a non-pass | `EVAL_STAGE_FAILED`, `EVAL_STAGE_TIMEOUT`, `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT` |
| `needs_input` | Yes, as a non-pass | `EVAL_STAGE_NEEDS_INPUT`: the stage stopped at a human gate. Evals cannot answer gates |
| `error` | Yes, as a non-pass, and counted in `errored` | `EVAL_AGENT_EMPTY_REPLY`, `EVAL_SIMULATOR_ERROR`, `EVAL_ENGINE_ERROR`. Not graded |
| `skipped_budget` | No | `EVAL_BUDGET_EXCEEDED`: the cap was hit before this case started |
| `cancelled` | No | `EVAL_CANCELLED` |

Open one result with the run detail's cases, or in the console. A result's `error_code` is the code in the table. Grade-level codes (`EVAL_JUDGE_ERROR`, `EVAL_GRADER_CODE_ERROR`, `EVAL_CASE_MISSING_EXPECTED`, `EVAL_GRADER_NOT_APPLICABLE`) sit on a grade, not on the result status. A grade error is left out of that result's score rather than failing it. That is why a run full of judge errors can show a healthy pass rate. Quote `by_grader[].errors` next to the pass rate.

## Graders, scores, and errors

A result's score is the weighted mean of its graded scores, leaving out `must_pass` graders and grades that errored. The result passes when no `must_pass` grader failed and the score is at least `pass_threshold`. You do not need to recompute this to report the run. Use it to explain a single surprising case: open that case's grades and quote each grade's `passed`, `score`, and `reason`.

`by_grader[].pass_rate` ignores grades with status `error`. A grader with a high pass rate and a high `errors` count is not measuring the cases that errored.

## Compare

```bash
sf eval compare <baselineEvalRunId> <candidateEvalRunId> --json
```

The first id is the baseline (`a`), the second is the candidate (`b`). The command prints JSON either way. Runs of different evals, or a stage run against an agent run, fail `EVAL_COMPARE_MISMATCH`.

The comparison is paired by case. Quote these fields and do not derive a verdict from `mean_difference` yourself:

| Field | Meaning |
|---|---|
| `verdict` | `improved` (the 95% interval of the per-case change is entirely above 0), `regressed` (entirely below 0), `no_clear_difference` (the interval includes 0), `insufficient_data` (fewer than 5 shared cases, or no interval) |
| `ci` | That interval, `{ low, high }` |
| `mean_difference` | Mean of (candidate pass fraction − baseline pass fraction) per shared case |
| `shared_cases`, `cases_a`, `cases_b` | How many cases overlap |
| `cases_needed_5pts` | About how many shared cases would be needed to detect a 5 point difference. `null` when it cannot be estimated |
| `warnings` | Why the scores may not be comparable. See below |
| `deltas` | Each is `{ a, b, delta, percent_change }`. `percent_change` is `(b − a) / a × 100`, or `null` when `a` is 0 or a side is missing. Covers `cost_per_result`, `latency_p50`, `latency_p95`, `flaky_cases`, `mean_score`, and for agents `mean_turns` and `mean_tool_calls` |
| `graders` | `compared`, `changed`, `added`, or `removed`. A `changed` grader is not given a delta |
| `stage_diff` or `agent_diff` | What changed in the target, including a line diff of the prompt or instructions when they differ |
| `components` | Each snapshot piece as `same` or `changed` |
| `stats_a`, `stats_b` | The same stats object as a single run. Quote them; do not rebuild them |

| Warning | Meaning |
|---|---|
| `dataset_differs` | The datasets differ. Say so before quoting a verdict |
| `graders_differ` | A grader was added, removed, or edited |
| `judge_differs` | The judge model or the judge prompt version differs |
| `engine_differs` | The engine version differs |
| `few_shared_cases` | Fewer than 5 cases in common. The verdict is `insufficient_data` |

`no_clear_difference` means this dataset cannot show a change. It does not mean nothing changed. When the user wants a clearer answer, add cases (the compare result's `cases_needed_5pts` is the scale) rather than more repeats, and keep the dataset, graders, judge, and simulator the same on the next pair.

`cases[]` lists each shared case as `improved`, `regressed`, or `same`, with `p_a`, `p_b`, and `graders_changed`. Quote a case the user asks about. Do not average those flags into a new verdict.

## List status

`sf eval list --json` gives each eval a status computed from its completed runs. Quote it.

| Status | When |
|---|---|
| `never_run` | No completed run |
| `running` | A run is queued or running (this overlays the completed-run status) |
| `passing` | The last completed run passed |
| `saturated` | A `capability` eval whose last run passed at 98% or above. It can no longer show improvement. Keep it as `type: regression` and put harder cases in a new capability eval |
| `failing` | The last completed run did not pass |
| `regressed` | The last completed run did not pass and the one before it did |

`type` on the eval (`capability` or `regression`) changes no scoring. It only feeds this list status.
