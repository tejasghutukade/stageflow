# Result schema, scoring and statistics

Part of the [Evals epic](evals.md). Contract for what an eval run stores and how every number on the results pages is computed. Used by stories 04 (tables), 05 (stats), 06 (snapshot), 09 (manager), 13 (API) and 20, 21 (UI).

Rules that apply everywhere here:

- Tables are **target-neutral** (epic rule 5): no column is stage-specific. Stage details live in JSON columns.
- Nothing a past run stored is ever updated except: the run's own progress and final status while it runs, and the author's reviews and failure-type tags (their notes).
- Statistics are **computed on read** by `src/evals/stats.ts` from the tables, except `eval_runs.summary_json`, a copy of the headline numbers written once at finish so the Evals list is fast. If they disagree, the computed values win.

## Tables (migration `015-evals`)

SQLite, following `src/runstore/sqlite/migrations/014-agent-deliveries.ts` (`MIGRATION_015`, `version: 15`, `name: "015_evals"`, `minStageflowVersion: PACKAGE_VERSION`). Timestamps are ISO-8601 UTC strings like the rest of the store. Booleans are `INTEGER 0/1`.

```sql
ALTER TABLE runs ADD COLUMN origin TEXT;            -- NULL for normal runs, 'eval' for eval stage runs
CREATE INDEX runs_origin ON runs (origin);

CREATE TABLE eval_runs (
  eval_run_id TEXT PRIMARY KEY,                     -- 'er_' + 12 lowercase hex
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,                      -- 1, 2, 3 ... per (project_root, eval_id); shown as "Run #14"; never reused, even after deletes
  eval_path TEXT NOT NULL,                          -- project-relative
  eval_hash TEXT NOT NULL,                          -- sha256 of the eval file bytes at start
  target_kind TEXT NOT NULL CHECK (target_kind IN ('stage','agent')),
  target_ref_json TEXT NOT NULL,                    -- {"pipeline_path"?,"stage_id"?,"file"?} (agent later: {"agent_id","revision"})
  target_version_hash TEXT NOT NULL,
  dataset_path TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,                        -- config snapshot (below)
  config_fingerprint TEXT NOT NULL,                 -- 8 hex
  config_components_json TEXT NOT NULL,             -- per-component hashes for compare
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','budget_stopped')),
  status_reason TEXT,                               -- human text for failed/budget_stopped/cancelled
  passed INTEGER,                                   -- NULL until finished; 1 only if completed and pass_rate >= pass_threshold
  repeats INTEGER NOT NULL,
  pass_threshold REAL NOT NULL,
  max_cost_usd REAL NOT NULL,
  cases_total INTEGER NOT NULL,                     -- cases selected for this run
  results_total INTEGER NOT NULL,                   -- cases_total * repeats
  results_done INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,                 -- running total, stage + judge
  engine_name TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  stageflow_version TEXT NOT NULL,
  label TEXT,                                       -- optional free text from the run dialog, <= 80 chars
  started_via TEXT NOT NULL CHECK (started_via IN ('console','cli','mcp')),
  caller_id TEXT,
  summary_json TEXT,                                -- headline numbers copy, written at finish
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX eval_runs_number ON eval_runs (project_root, eval_id, run_number);
CREATE INDEX eval_runs_eval ON eval_runs (project_root, eval_id, created_at DESC);
CREATE INDEX eval_runs_status ON eval_runs (status);

CREATE TABLE eval_cases (                           -- snapshot of the cases used, so dataset edits never change history
  eval_run_id TEXT NOT NULL REFERENCES eval_runs (eval_run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  position INTEGER NOT NULL,                        -- file order
  case_json TEXT NOT NULL,                          -- the full case object
  PRIMARY KEY (eval_run_id, case_id)
);

CREATE TABLE eval_results (
  eval_run_id TEXT NOT NULL REFERENCES eval_runs (eval_run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,                    -- 0-based
  status TEXT NOT NULL CHECK (status IN ('completed','stage_failed','needs_input','error','skipped_budget','cancelled')),
  error_code TEXT,
  error_message TEXT,
  stage_run_id TEXT,                                -- runs.run_id of the stage run (NULL if never started)
  output_json TEXT,                                 -- normalized subject: {"status","summary","payload","artifacts"} for stages
  latency_ms INTEGER,                               -- stage run wall time, not judge time
  cost_usd REAL,                                    -- stage run cost only
  tokens_in INTEGER,
  tokens_out INTEGER,
  score REAL,                                       -- weighted score 0..1; NULL unless status = completed
  passed INTEGER NOT NULL DEFAULT 0,
  has_grader_errors INTEGER NOT NULL DEFAULT 0,
  budget_warnings_json TEXT,                        -- ["latency","cost"] when the eval's budget was exceeded
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (eval_run_id, case_id, repeat_index),
  FOREIGN KEY (eval_run_id, case_id) REFERENCES eval_cases (eval_run_id, case_id) ON DELETE CASCADE
);
CREATE INDEX eval_results_stage_run ON eval_results (stage_run_id);

CREATE TABLE eval_grades (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  grader_id TEXT NOT NULL,
  grader_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('graded','error')),
  passed INTEGER,                                   -- NULL when status = 'error'
  score REAL,                                       -- 0..1 normalized; NULL when error
  raw_value REAL,                                   -- e.g. 4 for a 1-5 rubric; equals score otherwise
  reason TEXT,
  details_json TEXT,                                -- reference each_mentioned: {"items":[{"text","found"}]}; field: {"checks":[{"path","op","passed","found"}]}; NULL otherwise
  error_code TEXT,
  judge_model TEXT,                                 -- rubric graders
  judge_cost_usd REAL,
  judge_tokens_in INTEGER,
  judge_tokens_out INTEGER,
  PRIMARY KEY (eval_run_id, case_id, repeat_index, grader_id),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);

CREATE TABLE eval_grader_versions (                 -- gives "rubric v3" its ordinal
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  grader_id TEXT NOT NULL,
  grader_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,                         -- 1, 2, 3 ... per (project_root, eval_id, grader_id), in order first seen
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_root, eval_id, grader_id, grader_hash)
);

CREATE TABLE eval_failure_types (                   -- the author's vocabulary, per eval
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  name TEXT NOT NULL,                               -- 1-60 chars, unique per eval, case-insensitive
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_root, eval_id, name COLLATE NOCASE)
);

CREATE TABLE eval_result_reviews (                  -- the author's own verdict on a result; the only other mutable result data
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('pass','fail')),
  note TEXT,                                        -- "Why", <= 500 chars
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, repeat_index),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);

CREATE TABLE eval_result_tags (                     -- failure-type tags; mutable
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, repeat_index, tag COLLATE NOCASE),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);
```

**Retention.** Eval runs are kept until the user deletes them (`DELETE /api/eval-runs/:id`, `sf eval runs delete`); deleting an eval run deletes its rows (cascade) and the stage runs it started (`runs.origin = 'eval'` with `stage_run_id` listed in its results). The existing run retention sweep (`src/runtime/runRetentionSweep.ts`) applies to eval stage runs like any run. When the sweep purges an eval stage run, `eval_results.stage_run_id` stays and the console shows "stage run purged" instead of a link.

**Agent extension.** `target_kind` already allows `'agent'`; `output_json` is the normalized subject (for an agent: the conversation subject). Migration 016 adds `subject_ref` and two summary columns: see [Release 2: agents](#release-2-agents).

## Config snapshot (`eval_runs.config_json`)

Written once at start, never edited. `snapshot_version: 1`.

```json
{
  "snapshot_version": 1,
  "eval": { "id": "", "path": "", "hash": "", "definition": { } },
  "overrides": { "repeats": null, "judge": null, "model": null, "max_cost_usd": null, "case_ids": null, "tags": null, "only_failed_from": null },
  "target": { "kind": "stage", "pipeline_path": null, "stage_id": null, "file": null,
              "stage_version_hash": "", "stage_definition": { }, "model": "", "model_tier": "", "input_schema_hash": "", "output_schema_hash": "" },
  "dataset": { "path": "", "hash": "", "format": "jsonl", "case_count": 0, "cases_run": 0, "cases_skipped": 0, "skipped_case_ids": [] },
  "graders": [ { "id": "", "type": "", "hash": "", "version_ordinal": 1, "weight": 1, "must_pass": false } ],
  "settings": { "repeats": 3, "pass_threshold": 0.8, "judge": "", "judge_same_as_stage": false,
                "max_cost_usd": 2, "concurrency": 4, "suite_type": "capability" },
  "engine": { "name": "promptfoo", "version": "", "rubric_prompt_version": 1, "node_version": "" },
  "stageflow_version": ""
}
```

`target.stage_definition` is the canonical materialized stage config (the exact JSON the stage version hash was computed from) so the compare view can show what changed in the stage. `dataset.cases_skipped` counts cases dropped because their `input` did not match the stage's `io.input.schema` ([run start rules](evals-file-schema.md#validation-findings)); they are not in `eval_cases`. `eval.definition` is the fully resolved eval object (defaults filled in, paths made project-relative). `overrides` hold run-dialog changes. `settings` hold the **effective** values.

**Fingerprint** = first 8 hex characters of sha256 over the canonical JSON (sorted keys) of:
`{ stage_version_hash, model, dataset_hash, case_ids (sorted; only when a subset ran, else null), graders: [{id, hash}] sorted by id, repeats, pass_threshold, judge, engine: {name, version}, rubric_prompt_version }`.
Excluded on purpose: `max_cost_usd`, `concurrency`, `label`, Stageflow and Node versions.

**`config_components_json`** = `{ stage, model, dataset, case_ids (null unless a subset ran), graders: {id: hash}, judge, repeats, pass_threshold, engine, rubric_prompt_version }` each as the exact value used in the fingerprint, so the compare view can name what was held constant and what changed.

## Statuses

| Eval run | Meaning |
|---|---|
| `queued` | created, engine not yet started |
| `running` | engine executing |
| `completed` | every selected result executed; `passed` is set |
| `failed` | the run could not finish (engine crashed, install broken); partial results kept; `passed = 0` |
| `cancelled` | the user cancelled; remaining results are `cancelled` |
| `budget_stopped` | `max_cost_usd` reached; remaining results are `skipped_budget`; `passed = 0` |

| Result | Meaning |
|---|---|
| `completed` | the stage run finished and produced an envelope (the envelope's own status may still be `failure`) |
| `stage_failed` | the stage run ended failed/cancelled-by-timeout with no usable envelope (`error_code` says why) |
| `needs_input` | the stage stopped at a gate (P7); stage run cancelled |
| `error` | Stageflow or the engine failed for this result (provider error, etc.) |
| `skipped_budget` / `cancelled` | not executed |

## Error codes (stored in `error_code`, returned by the API)

`EVAL_STAGE_FAILED`, `EVAL_STAGE_NEEDS_INPUT`, `EVAL_STAGE_TIMEOUT`, `EVAL_ENGINE_ERROR`, `EVAL_BUDGET_EXCEEDED`, `EVAL_CANCELLED`, `EVAL_JUDGE_ERROR`, `EVAL_GRADER_CODE_ERROR`, `EVAL_CASE_MISSING_EXPECTED` (result/grade level); `EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_ENGINE_UNAVAILABLE`, `EVAL_NODE_TOO_OLD`, `FILE_CHANGED`, `EVAL_NOT_FOUND`, `DATASET_NOT_FOUND`, `EVAL_RUN_NOT_FOUND` (request level). Messages never contain provider response bodies, request URLs or secrets.

## Scoring

Per result, after all graders ran:

1. A result with `status ≠ completed` has `score = NULL`, `passed = 0`, and no grades.
2. **Must-pass graders:** if any `must_pass` grader has `passed = 0`, or `status = error`, the result fails.
3. **Weighted score** = `Σ (weight_i × score_i) / Σ weight_i` over graders that are **not** `must_pass` and have `status = graded`. A grader with `status = error` is left out of both sums and sets `has_grader_errors = 1`. If no such grader remains the weighted score is `1` when all must-pass graders passed, otherwise `0`.
4. **Passed** = (no must-pass failure) **and** (`weighted score ≥ pass_threshold`).
5. A grader's own `passed`: `schema`/`field`/`code(boolean)`/`rubric pass_fail`: its verdict. `reference each_mentioned`: `score ≥ pass_at`. `rubric 1_to_5`: `raw ≥ pass_at`. `code` returning a number: `score ≥ pass_threshold`. The grader's `passed` is used for must-pass and for per-grader pass rate; the weighted score uses `score`, not `passed`.
6. **Budget warnings:** if the eval's `budget.latency_ms` or `budget.cost_usd` is exceeded by the result's `latency_ms` / `cost_usd`, add `"latency"` / `"cost"` to `budget_warnings_json`. They do not change `passed`.

**Run `passed`** = `status = completed` and `pass_rate ≥ pass_threshold` (below). `failed`, `cancelled` and `budget_stopped` runs always have `passed = 0`; their statistics are still computed over the results that executed and the UI labels them incomplete.

## Statistics (`src/evals/stats.ts`)

**Executed** results are those with status `completed`, `stage_failed`, `needs_input` or `error`. `skipped_budget` and `cancelled` are never counted. All formulas below use executed results only. Errored results count as **failed** in pass rate (P4) and are reported separately as `errored`. A *case* is counted if it has ≥ 1 executed result. Let `n` be the number of counted cases, `executed_c` and `passed_c` the executed and passed results of case `c`, `p_c = passed_c / executed_c`, `p̄ = mean(p_c)`.

| Stat | Definition |
|---|---|
| `results_executed`, `results_passed`, `errored` | counts |
| `pass_rate` | `results_passed / results_executed` (0 when none) |
| `pass_rate_ci` | `pass_rate ± t × SE`, clamped to [0, 1]; `SE = sqrt( Σ (p_c − p̄)² / (n (n − 1)) )`; `t` is the two-sided 95% Student-t quantile for `n − 1` degrees of freedom (table below; 1.96 when `df > 30`). `null` when `n < 2`. Cases are the independent units; repeats of one case are not independent, so this is wider than a plain binomial interval on purpose. |
| `mean_score` | mean of `score` over `completed` results |
| `score_spread` | mean over cases with ≥ 2 completed results of the sample standard deviation (n−1) of that case's scores; `null` if no such case |
| `reliability` (`pass^k`) | among counted cases with `executed_c ≥ 2`: share where `passed_c = executed_c`; `k` = the run's `repeats`; `null` if `repeats = 1` |
| `pass_any` (`pass@k`) | same cases: share where `passed_c ≥ 1` |
| `flaky_cases` | cases with `executed_c ≥ 2` and `0 < passed_c < executed_c`; list of ids |
| `latency_p50`, `latency_p95`, `latency_max` | over `completed` results' `latency_ms`; nearest-rank percentiles (`idx = ceil(q × m) − 1` on the sorted list) |
| `cost_stage`, `cost_judge`, `cost_total` | sums of `eval_results.cost_usd`; of `eval_grades.judge_cost_usd`; both |
| `cost_per_result` | `cost_total / results_executed` |
| `tokens_in`, `tokens_out` | sums over results (stage) and, separately, over grades (judge) |
| `by_grader[g]` | `graded` (status graded), `passed`, `pass_rate = passed/graded`, `mean_raw` (mean of `raw_value`), `min_raw`, `max_raw`, `errors`. For `1_to_5` rubrics `mean_raw` is on the 1–5 scale; for others `raw_value = score`. |
| `by_grader[g].delta` | `pass_rate − previous.pass_rate` in percentage points, where *previous* is the most recent earlier `completed` eval run of the same eval that contains grader `g` with the **same grader hash**; `null` otherwise (the UI shows "—", or "grader changed" when only the hash differs) |
| `score_histogram` | 10 bins `[0,0.1) … [0.9,1.0]` over `completed` results' `score`, plus the threshold |
| `failure_types` | over **failed** executed results: count per tag (a result with two tags counts once under each), plus `untagged` = failed results with no tag |
| `failing_cases` | counted cases with `passed_c < executed_c`, ordered by `p_c` ascending, then mean score ascending, then case id; each with its per-repeat pass flags in repeat order |

Student-t two-sided 95% quantiles, `df` 1–30: 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042.

Worked examples for tests (hand-computed):

1. 10 cases, 1 repeat each, 8 passed, 2 failed: `p̄ = 0.8`, `Σ(p_c − p̄)² = 8×0.04 + 2×0.64 = 1.6`, `SE = sqrt(1.6 / 90) = 0.13333`, `t(9) = 2.262`, half-width `0.3016`, CI `[0.498, 1.0]` (upper clamped from 1.1016). `reliability = null` (repeats 1).
2. 4 cases × 2 repeats with case pass counts `[2, 2, 1, 0]`: `pass_rate = 5/8 = 0.625`, `p = [1, 1, 0.5, 0]`, `p̄ = 0.625`, `Σ dev² = 0.6875`, `SE = sqrt(0.6875/12) = 0.23936`, `t(3) = 3.182`, half-width `0.7616`, CI `[0, 1]` (both clamped). `reliability = 2/4 = 0.5` (cases 1, 2), `pass_any = 3/4 = 0.75`, `flaky_cases = [case 3]`.

## Compare (`compareRuns(a, b)`)

Both runs must belong to the same eval (`eval_id`); otherwise `400 EVAL_COMPARE_MISMATCH`. By convention `a` is the baseline and `b` the candidate; the UI defaults `b` to the selected run and `a` to the previous completed run.

- **Shared cases** = case ids counted in both runs. `m` = their number.
- Per shared case: `d_c = p_b,c − p_a,c`. Mean difference `d̄ = mean(d_c)`. CI: `d̄ ± t(m − 1) × SE_d`, `SE_d = sqrt( Σ (d_c − d̄)² / (m (m − 1)) )`, clamped to [−1, 1]; `null` when `m < 2`. This is a **paired, clustered** interval: both runs saw the same cases, so case difficulty cancels.
- **Verdict:** `improved` if `ci_low > 0`; `regressed` if `ci_high < 0`; otherwise `no_clear_difference`; `insufficient_data` when `m < 5`.
- Per case: `improved` if `d_c > 0`, `regressed` if `d_c < 0`, else `same`; list the regressed cases first.
- Per grader (graders present in both with the same hash): change in `pass_rate` in percentage points over shared cases. Graders whose hash differs are listed as `changed` with no delta.
- Deltas of `cost_per_result`, `latency_p50`, `latency_p95`, `flaky_cases` count, `mean_score`.
- **Stage diff:** from `config.target.stage_definition` of each run: `changed_keys` (top-level keys of the stage config whose canonical JSON differs, for example `system_prompt`, `model`, `io.output`) and, when `system_prompt` differs, a **line diff** of the two prompts (`[{ op: "same"|"add"|"remove", text }]`, computed server-side). If the stage version hashes are equal, `stage_diff` is `null`.
- **Per-case detail** (for the "Cases that changed" list): `p_a`, `p_b`, `d`, the per-repeat pass flags of each run, mean score of each, and `graders_changed`: ids of graders whose count of passed repeats differs between the runs for that case.
- **Detectable change:** `sd_d` = sample standard deviation of `d_c`; `cases_needed_5pts = ceil((1.96 × sd_d / 0.05)²)` (the number of cases needed to detect a 5-point difference at this variability); `null` when `m < 2`. The UI shows it as "about N cases are needed to detect 5 points".
- **Components:** for each key of `config_components_json`, `same` or `changed` with both values. Fingerprints equal → "same config".
- **Warnings:** dataset hashes differ (only shared cases compared, `m of n_a / n_b`); any grader hash differs ("graders differ; scores are not comparable"); `engine` differs; `m < 5`.

## List status (Evals list, `src/evals/listStatus.ts`)

From the eval's **completed** runs only, newest first (`last`, `previous`):

| Status | Rule |
|---|---|
| `never_run` | no completed run |
| `saturated` | `type = capability`, `last.passed`, and `last.pass_rate ≥ 0.98` |
| `passing` | `last.passed` (and not saturated) |
| `regressed` | `not last.passed` and `previous` exists and `previous.passed` |
| `failing` | `not last.passed` and (no `previous` or `not previous.passed`) |

**Regression banner** (top of the list): shown when at least one eval is `regressed`; names the one whose `last` finished most recently. Text: `<eval id> regressed`, then `Pass rate <previous>% → <last>% · <k> criteria dropped · run #<n> vs #<m>`, link to Compare. `k` = number of graders present in both runs with the same hash whose pass-rate change is ≤ −5 percentage points.

**Last run column:** `last.pass_rate`, and `last.pass_rate − previous.pass_rate` in percentage points (`null` if no `previous`), plus a bar. **Trend:** the last 7 completed runs, oldest to newest, one dot each: green if `passed`; amber if not passed and `pass_rate ≥ pass_threshold − 0.05`; red otherwise. **Cost / run:** `last.cost_total`. **List footer:** counts of evals and datasets and the sum of `cost_total` of eval runs finished in the last 7 days.

## Cost estimate

Shown in the run dialog and the Review step. `estimate = results_total × avg_stage_cost + rubric_grades × avg_judge_cost`, where `rubric_grades = results_total × (number of rubric graders)`.

- `avg_stage_cost` and `avg_judge_cost`: from the most recent `completed` eval run of the same eval (`cost_stage / results_executed` and `cost_judge / rubric grades`). If none exists: `avg_stage_cost` is the mean `cost_usd` of the target stage's last 20 non-eval stage executions with a recorded cost; if there are none, the estimate is `null` and the UI says "No cost history yet; the limit still applies". `avg_judge_cost` is `null` without history, and the UI says the estimate excludes judge calls.
- Calls: `stage_calls = results_total`; `judge_calls = results_total × (number of rubric graders)`.
- Time: `estimate_seconds = (previous.finished_at − previous.started_at) × results_total / previous.results_executed`, where *previous* is the most recent `completed` run of the same eval; `null` without one. The run's `concurrency` is not rescaled.
- "Based on run #n" names that run; without a previous run the UI says "No previous run to base this on".
- The estimate is advisory and never blocks a run. The cost limit does.

---

# Release 2: agents

Part of the [Evals for agents plan](evals-agents.md). Tables stay target-neutral (epic rule 5). Agent details live in `output_json` and the config snapshot. Used by A04 (migration, snapshot), A05/A07 (what a result stores), A08 (what graders read), A09 (stats), A10 (wire shapes). Facts: [evals-agents-verification.md](evals-agents-verification.md) sections 8, 12, 13.

## Migration `016_eval_subject_ref`

`MIGRATION_016` (`version: 16`, `name: "016_eval_subject_ref"`, `minStageflowVersion: PACKAGE_VERSION`). Forward-only, no table rebuild (the `status` CHECK of migration 015 is **not** touched; `target_kind` already allows `'agent'`):

```sql
ALTER TABLE eval_results ADD COLUMN subject_ref TEXT;          -- root subject id: stage run id (stage) or agent session id (agent); NULL if never started
ALTER TABLE eval_results ADD COLUMN turns INTEGER;             -- agent: user turns completed; NULL for stage rows
ALTER TABLE eval_results ADD COLUMN tool_call_count INTEGER;   -- agent: recorded tool calls (every outcome); NULL for stage rows
UPDATE eval_results SET subject_ref = stage_run_id WHERE stage_run_id IS NOT NULL;
CREATE INDEX eval_results_subject_ref ON eval_results (subject_ref);
```

- Stage rows keep `stage_run_id` (wire field `stage_run_id`) and also get `subject_ref = stage_run_id`. Agent rows write `stage_run_id = NULL`, `subject_ref = <root agent session id>`. The kind of subject is the run's `target_kind` (no `subject_kind` column; the A00 draft is dropped).
- Descendant sessions (sub-agents) are **not** rows; they are found through `agent_sessions.source = 'eval' AND source_ref = <parent session id>` recursively. The root eval session has `source_ref = <eval_run_id>`.
- `output_json` for agents is the [conversation subject](#conversation-subject) (without the transport-only `transcript` field).
- `latency_ms` = wall clock of the whole conversation (agent turns + simulator calls). `cost_usd` = root session turns + descendant sessions + simulator calls (judge cost stays in `eval_grades`). `tokens_in`/`tokens_out` = agent (root + descendants) only; simulator tokens are in `output_json.usage`.
- Retention: deleting an eval run deletes the agent sessions listed by `listEvalSubjectRefs` and their descendants through the agent service (`deleteEvalSessions`; messages, turns, spans, approvals cascade); `deleteEvalRun` keeps returning stage run ids only. There is no existing agent retention (verification section 5), so the manager also sweeps on boot: eval sessions older than 7 days that no `eval_results.subject_ref` references, and the sessions of runs it recovers as `failed`. When a result's session is gone the console shows "agent session deleted" instead of the link; the stored subject still renders.

## Conversation subject

The normalized subject of an agent result (`CaseOutput.kind: "conversation"`), what graders read and what `eval_results.output_json` stores. Built by the Host (`buildConversationSubject`, A07) from `getSession` detail plus the tool-call ledger; **every text is redacted (`redactSecrets`) before it is capped** because `agent_messages` are stored unredacted (verification section 3).

```json
{
  "kind": "conversation",
  "status": "success",
  "summary": "3 turns, 2 tool calls, ended resolved",
  "messages": [
    { "role": "user", "text": "I was charged twice and I want my money back.", "turn": 1 },
    { "role": "assistant", "text": "I am sorry about that. Let me look up the invoice. Which invoice is it?", "turn": 1 },
    { "role": "user", "text": "INV-2093", "turn": 2 },
    { "role": "assistant", "text": "I found a duplicate charge. I have escalated this to a person.", "turn": 2 }
  ],
  "tool_calls": [
    { "id": "call_1", "turn": 2, "name": "billing.lookup_invoice", "args": { "invoice_id": "INV-2093" },
      "result_summary": "{\"status\":\"duplicate\"}", "status": "ok", "policy_outcome": "mocked" },
    { "id": "call_2", "turn": 2, "name": "billing.refund", "args": { "invoice_id": "INV-2093" },
      "result_summary": "billing.refund was not executed in this evaluation.", "status": "not_run", "policy_outcome": "stubbed" }
  ],
  "final_reply": "I found a duplicate charge. I have escalated this to a person.",
  "turns": 2,
  "stop_reason": "resolved",
  "usage": { "cost_usd": 0.041, "agent_cost_usd": 0.036, "simulator_cost_usd": 0.005, "tokens_in": 5210, "tokens_out": 640,
             "simulator_tokens_in": 1180, "simulator_tokens_out": 70, "simulator_estimated": false, "agent_calls": 6, "simulator_calls": 2 },
  "truncated": { "messages": 0, "tool_results": 1, "tool_args": 0, "tool_calls_dropped": 0 }
}
```

| Field | Type | Rule |
|---|---|---|
| `kind` | `"conversation"` | discriminator (G10). `CaseOutput` is `envelope \| conversation`. |
| `status` | `"success"` \| `"failure"` | `success` when the conversation reached any stop reason; `failure` only in the partial subject stored with a failed result (the engine normalizer requires one of these two values and the Host's subject ref). |
| `summary` | string | generated: `<turns> turns, <n> tool calls, ended <stop_reason>` (or the failure reason). |
| `messages[]` | `{ role: "user"\|"assistant", text, turn }` | `turn` is the 1-based user turn the message belongs to; assistant messages of a turn follow its user message. ≤ 4,000 chars per text. |
| `tool_calls[]` | `{ id, turn, name, args, result_summary, status, policy_outcome, session_id? }` | `name` is the grant id (`read`, `stageflow.get_agent`, `billing.lookup_invoice`, `agent:helper`). `args` is the redacted argument object. `result_summary` is the redacted result text, ≤ 1,000 chars. `status`: `ok` (ran or mock `result`), `error` (ran and failed, or mock `error`), `not_run` (`stubbed`, `would_ask_first`, `denied`). `session_id` only on sub-agent calls (the child eval session). Ledger order = call order. |
| `final_reply` | string | last assistant message; `""` when none. |
| `turns` | integer | user turns completed (a turn counts once the agent replied or failed). |
| `stop_reason` | enum | `script_end`, `resolved`, `abandoned`, `max_turns`, `no_progress`, `empty_message` for completed conversations; `error` and `timeout` in partial subjects of failed results. |
| `usage` | object | `cost_usd` = result cost (`agent_cost_usd` + `simulator_cost_usd`, descendants included in agent); `simulator_estimated` is true when the simulator cost came from the chars/4 fallback (the model port reported no usage). |
| `truncated` | object | counts of fields cut by the caps; the object is omitted when all are zero. |

`policy_outcome` values: `ran`, `stubbed`, `mocked`, `would_ask_first`, `denied` (precise meaning in [file-schema](evals-file-schema.md#tool-policy-conversationtools)).

**Caps** (constants `EVAL_CONVERSATION_LIMITS` in `src/evals/constants.ts`): 4,000 chars per message, 1,000 per `result_summary`, 2,000 per serialized `args` (over the cap `args` becomes `{ "_truncated": "<first 2000 chars of the JSON>" }`), 80 messages (the first 4 and last 76 are kept; `truncated.messages` counts the dropped), 200 tool calls (`tool_calls_dropped` counts the rest), 256 KB for the whole subject (a harder cut drops the oldest middle messages). Cut text ends with `…[truncated N chars]`. The same JSON is what graders, the judge's renderer and the console read, so graders see capped text; docs say so.

**Transport-only field.** The `run-case` reply and the promptfoo output string also carry `transcript` (string): the bounded rendered transcript for the judge ([engine-interface](evals-engine-interface.md#release-2-agents)). The manager drops it before storing; the read model re-renders it when needed.

## Status and error-code mapping for agents

The six stored result statuses and the CHECK of migration 015 are **kept**; there are no wire aliases in release 2. `stage_failed` keeps its name but means "the target (stage run or agent conversation) failed"; the console labels it from `target_kind` and `error_code`.

| Outcome | `status` | `error_code` | Stored `output_json` | Graded |
|---|---|---|---|---|
| Conversation ran to a stop reason (including `max_turns`, `abandoned`, `no_progress`, `empty_message`) | `completed` | none | full subject, `status: success` | yes |
| An agent turn failed: `agent.backend_failed`, `agent.guardrail_blocked`, `agent.model_timeout`, `agent.limit_reached`, `agent.archived`, `agent.revision_not_found`, a turn left `failed` | `stage_failed` | `EVAL_AGENT_FAILED` | partial subject, `status: failure`, `stop_reason: error` | no |
| Per-turn timeout (`turn_timeout_ms`, the turn was stopped with `chat.stop`) or case wall clock exceeded | `stage_failed` | `EVAL_AGENT_TIMEOUT` | partial subject, `stop_reason: timeout` | no |
| Simulator call failed or returned nothing usable (not an empty message, which is a stop) | `error` | `EVAL_SIMULATOR_ERROR` | partial subject | no |
| Host cannot run agents (no agent service), session could not be opened, engine/provider failure, a turn unexpectedly waiting for approval | `error` | `EVAL_ENGINE_ERROR` | none | no |
| Cost cap reached before the case started | `skipped_budget` | `EVAL_BUDGET_EXCEEDED` | none | no |
| Run cancelled | `cancelled` | `EVAL_CANCELLED` | none | no |
| `needs_input` | not produced for agents (no turn can wait; G7) | | | |

Error messages carry the agent error code in text (`agent.guardrail_blocked`) but never provider bodies, URLs or secrets. A result that fails keeps its partial transcript so the console can show how far it got; partial subjects have no grades and `score = NULL`, as for every non-`completed` result.

New codes: `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_SIMULATOR_ERROR`, `EVAL_GRADER_NOT_APPLICABLE` (grade-level) are added to `EVAL_RESULT_ERROR_CODES`; `EVAL_REAL_TOOLS_NOT_CONFIRMED` is added to `EVAL_REQUEST_ERROR_CODES`. The error-codes paragraph above gains them. The cost cap is **not** enforced inside a running conversation: a case that started finishes (bounded by `max_turns`), so spend can exceed `max_cost_usd` by up to `concurrency` conversations; the estimate copy says so.

## Config snapshot (agents)

`snapshot_version` stays `1`: `target` is a discriminated union readable by old readers (stage snapshots are byte-identical to today's). Agent runs write:

```json
{
  "snapshot_version": 1,
  "eval": { "id": "support-basics", "path": "evals/support-basics.eval.yaml", "hash": "", "definition": { } },
  "overrides": { "repeats": null, "judge": null, "model": null, "user_model": null, "tools": null, "approvals": null,
                 "max_cost_usd": null, "case_ids": null, "tags": null, "only_failed_from": null },
  "target": {
    "kind": "agent",
    "agent_id": "support",
    "revision": 4,
    "definition_hash": "",
    "definition": { },
    "model": "anthropic/claude-sonnet-4-5",
    "model_tier": "",
    "tools": [ { "id": "read", "risk": "read", "class": "read" }, { "id": "billing.refund", "risk": "unknown", "class": "mcp_unknown" } ],
    "ask_first": [ "billing.refund" ],
    "sub_agents": [ { "id": "helper", "revision": 2 } ],
    "limits_override": {
      "agent":     { "max_turns": 40, "session_minutes": 10, "cost_usd": null, "always_on": false },
      "effective": { "max_turns": 9,  "session_minutes": 22, "cost_usd": null, "always_on": false },
      "capture": "full", "otlp": false, "groundedness": false
    }
  },
  "dataset": { "path": "", "hash": "", "format": "jsonl", "case_count": 0, "cases_run": 0, "cases_skipped": 0, "skipped_case_ids": [] },
  "graders": [ { "id": "", "type": "", "hash": "", "version_ordinal": 1, "weight": 1, "must_pass": false } ],
  "settings": {
    "repeats": 3, "pass_threshold": 0.8, "judge": "", "judge_same_as_stage": false, "max_cost_usd": 1, "concurrency": 2, "suite_type": "capability",
    "conversation": { "mode": "simulated", "max_turns": 8, "turn_timeout_ms": 120000, "tools": "read_only", "approvals": "record_only",
                      "read_only_tools": [], "real_tools_confirmed": false, "user_model": "", "user_model_from_judge": true,
                      "simulator_prompt_version": 1 }
  },
  "engine": { "name": "promptfoo", "version": "", "rubric_prompt_version": 1, "node_version": "" },
  "stageflow_version": ""
}
```

- `definition` is the canonical revision definition the hash was computed from (after the model override). `tools[]` lists every granted tool with its `risk` and classification `class` (`read`, `write`, `shell`, `destructive`, `external`, `mcp_unknown`, `sub_agent`, `browser`, `operator_only`) so the console can show what was stubbed without the live agent. `sub_agents[].revision` records the callee revisions at start (recorded, not pinned, release 2).
- `settings.judge_same_as_stage` is reused (true when the judge equals the agent model).
- For agent runs `engine.rubric_prompt_version` holds `CONVERSATION_RUBRIC_PROMPT_VERSION` (the rubric variant their judges use); the stage constant `RUBRIC_PROMPT_VERSION` is untouched, defined once and re-exported (today it is defined twice: `constants.ts` and `rubricPrompt.ts`), so no stage fingerprint moves (plan G11 "bump" is realized as a separate constant, owner decision 11). `SIMULATOR_PROMPT_VERSION = 1` lives in `settings.conversation`.
- `real_tools_confirmed` records the run-time consent; it is not in the fingerprint.

**Fingerprint (agents)** = first 8 hex characters of sha256 over the canonical JSON of the release 1 object with these differences: `stage_version_hash` holds the agent `definition_hash`; `model` is the effective agent model; `rubric_prompt_version` holds `CONVERSATION_RUBRIC_PROMPT_VERSION`; and one extra key, present **only for agent runs**, so stage payloads hash identically:

```json
"agent": { "revision": 4, "mode": "simulated", "max_turns": 8, "turn_timeout_ms": 120000, "tools": "read_only", "approvals": "record_only",
           "read_only_tools": [], "user_model": "anthropic/claude-sonnet-4-5", "simulator_prompt_version": 1 }
```

Excluded on purpose (as for stages): `max_cost_usd`, `concurrency`, `label`, versions of Stageflow and Node, and `real_tools_confirmed`. `user_model` is included only when some selected case runs `simulated`, else `null`. `config_components_json` for agents adds the same `agent` object under the key `agent` and holds the definition hash under `stage`, so Compare can name what changed ("agent definition", "tool policy", "simulator").

## Statistics additions (`stats.ts`, `compare.ts`)

All formulas and rules above are unchanged. Two plain means are added, **only when the run has agent data** (stage `Stats` objects keep exactly their current keys):

| Stat | Definition |
|---|---|
| `mean_turns` | mean of `eval_results.turns` over **executed** results that have a value; `null` when none |
| `mean_tool_calls` | mean of `eval_results.tool_call_count` over the same results; `null` when none |

Per-case rows (`ResultRow`) carry `turns` and `tool_calls` as the mean over that case's executed repeats. `Compare` adds `mean_turns` and `mean_tool_calls` `NumberDelta`s only when both runs are agent runs; no interval or verdict uses them. A stage run and an agent run of different targets never compare (`EVAL_COMPARE_MISMATCH`, by `eval_id`). `latency_*` and `cost_*` for agents are per conversation. `cost_stage` is the target cost (agent + sub-agents + simulator); the UI labels it "Agent" for agent runs. Hand-computed test (A09): results with `turns` [2, 4, null (errored), 6] -> `mean_turns = 4`.

**Compare, agent diff.** For two agent runs `CompareResult.stage_diff` is `null` and `agent_diff` is present when the definition hashes differ: `changed_keys` (top-level keys of the agent definition whose canonical JSON differs, for example `instructions`, `model`, `tools`, `limits`), a line diff of `instructions` when it differs (same shape as the prompt diff), and the revision numbers `{ a, b }`. Components also show tool policy, approvals, mode, max turns and user model changes.

## Cost estimate (agents)

Release 1 rules stand. The response keeps `stage_calls` (= `results_total`, conversations) and adds `simulator_calls` (see API). With a previous completed run the estimate uses its actual mean cost per result, which already includes sub-agents and simulator. Without one (`based_on_run_number: null`), `estimate.ts` applies fixed assumptions (constant `AGENT_ESTIMATE_ASSUMPTIONS`, shown in the run dialog help): `T = min(max_turns, 6)` user turns for simulated, the case's script length (capped by `max_turns`) for script; 2 tool calls per turn; agent call 2,000 tokens in / 200 out; simulator call 1,000 / 60 (none in script mode, `T - 1` calls otherwise); judge call 3,000 / 100 per `rubric` and `goal_reached` grader; prices from the model catalog. If a needed price is unknown the estimate is `null` ("No cost history yet; the limit still applies") and `judge_included` is false when judge prices are unknown. The estimate is advisory; the limit is checked only between cases.
