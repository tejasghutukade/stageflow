---
layout: default
title: Evals
---

# Evals

An **eval** answers one question about a stage: is it any good, and did my last change make it better or worse? It runs one stage over many realistic inputs, grades every output, repeats each input to measure how stable the stage is, and lets you compare two runs.

Evals are a general quality tool for configurable stages. A stage that triages tickets, summarizes research, reviews a draft, classifies an email, writes release notes or checks an ops runbook can all be evaluated the same way. Nothing in an eval is specific to one domain.

An eval is a file in your project, `evals/<id>.eval.yaml`. It names a **target** (one stage), a **dataset** of cases (`datasets/<name>.dataset.jsonl`), a list of **graders** and run defaults. You run it from the console, the CLI or MCP. Results are stored in the run store, so they survive restarts and can be compared later. Saving an eval never changes past runs: each run keeps a snapshot of exactly what it used.

## Concepts

| Term | Meaning |
|------|---------|
| **Eval** | The definition file `evals/<id>.eval.yaml`: target, dataset, graders, defaults |
| **Target** | What the eval tests. Today one stage (`kind: stage`) |
| **Dataset** | A file of cases |
| **Case** | One test input with an `id`, an `input`, and optional `expected`, `tags`, `title`, `goal`, `metadata` |
| **Repeat** | One execution of a case. Each case runs `repeats` times because models vary |
| **Result** | One (case, repeat): the stage output plus its grades. 24 cases with 3 repeats make 72 results |
| **Grader** | One rule that scores a result: `schema`, `field`, `reference`, `rubric` or `code` |
| **Grade** | One grader's verdict on one result |
| **Rubric** | A grader written in words and judged by a model |
| **Judge** | The model that applies rubrics |
| **Eval run** | One execution of an eval: all results, grades, statistics, cost, and a config snapshot |
| **Stage run** | The normal Stageflow run started for each result. Marked `origin = eval` and hidden from the Runs list, Inbox and Overview |
| **Config snapshot** | Everything that determined an eval run, stored with it and never edited |
| **Fingerprint** | The first 8 hex characters of a hash of the config snapshot. Equal fingerprints mean the same setup |
| **Engine** | The component that executes results and grades them. Today [promptfoo](https://github.com/promptfoo/promptfoo), installed on demand |

See also the [Glossary](glossary.md).

## Quick start with the sample

The repository ships a small sample in [`examples/evals/`](../examples/evals/): a `critique` stage that reviews short draft specifications, 8 cases (6 with a planted problem, 2 clean), and four graders that need no judge model. See the [sample README](../examples/evals/README.md).

1. **Set a default model.** The sample stage has no `model:`, so it uses the project default. Add one to `stageflow.yaml`:

   ```yaml
   version: 1
   model: anthropic/claude-sonnet-4-5   # any model id you have a provider for
   ```

   Without a default `model`, the pipeline does not load and `sf validate` reports `eval.target_unresolved` ("Target pipeline … does not load").

2. **Get the sample into your project.** From a checkout, the catalog in the repository root already lists `examples/evals`. In another project, open the console (`sf ui`), go to **Evals** and choose **Try the sample eval**. It copies the pipeline, eval and dataset into your project's `pipelines/`, `evals/` and `datasets/` roots and rewrites the eval's two path lines. If it already exists, the console opens it instead.

3. **Validate and install the engine** (once per machine, needs Node 22.22 or newer and network access):

   ```bash
   sf validate --strict
   sf eval validate critique-sample
   sf eval engine install
   ```

4. **Run it:**

   ```bash
   sf eval run critique-sample
   ```

   This calls your model for each case and repeat (8 cases x 2 repeats = 16 stage runs). `max_cost_usd: 1` caps the spend. The command waits, prints the outcome, and exits `0` only when the run passed.

Some failures are normal. The reference grader looks for keywords such as `expir` or `backoff`, so a correct finding worded differently can fail. Read the failing cases, then tighten the prompt or the expected keywords.

## Writing an eval

A complete file, with every section:

```yaml
version: 1
id: review-findings
name: Review findings
description: Review flags real defects
type: capability
target:
  kind: stage
  pipeline: ../pipelines/feature-ship.pipeline.yaml
  stage: review
dataset: ../datasets/review-diffs.dataset.jsonl
task:
  goal: Review the change and list defects.
defaults:
  repeats: 3
  judge: anthropic/claude-sonnet-4-5
  pass_threshold: 0.8
  max_cost_usd: 2
  concurrency: 4
graders:
  - id: output-schema
    type: schema
    must_pass: true
  - id: findings-cite-lines
    type: field
    checks:
      - { path: "payload.findings[*].file", op: not_empty }
      - { path: "payload.findings[*].line", op: exists }
  - id: finds-expected-issues
    type: reference
    weight: 3
    mode: each_mentioned
    path: payload.findings
    expected: expected.findings
  - id: clear-and-actionable
    type: rubric
    rubric: A developer could act on each finding without asking questions.
    scale: 1_to_5
    pass_at: 4
budget:
  latency_ms: 300000
  cost_usd: 0.3
```

The full key tables are in [YAML catalog: Evals](yaml-catalog.md#evals-eval-yaml). Unknown keys are errors, so typos are caught.

### Target

The target is one stage, in one of two forms (paths are relative to the eval file):

```yaml
target: { kind: stage, pipeline: ../pipelines/ship.pipeline.yaml, stage: review }   # a stage of a pipeline
target: { kind: stage, file: ../stages/review.yaml }                                 # a standalone stage file
```

The stage version hash (first 6 hex characters, shown in the console) changes whenever anything that can change the stage's behavior changes: prompt, model, `io`, `verify`, `mcp`, `gate_kinds`, `timeout_ms`.

### Defaults

`repeats` (1 to 10, default 3), `pass_threshold` (default 0.8), `max_cost_usd` (default 2), `concurrency` (1 to 8, default 4), `judge` (a model id such as `anthropic/claude-sonnet-4-5`) and `model` (replaces the stage's model for every case). A run can override `repeats`, `judge`, `model`, `max_cost_usd` and the case selection without editing the file; the overrides are recorded in the snapshot.

### Graders

Every grader has an `id`, a `type`, an optional `description`, a `weight` (default 1) and `must_pass` (default `false`). A `must_pass` grader that fails fails the result whatever the score, and is left out of the weighted mean. An eval has 1 to 20 graders.

**`schema`.** Passes when the envelope `status` is `success` and the payload validates against the stage's `io.output.schema`. Needs the stage to declare one (otherwise `eval.schema_grader_without_output_schema`).

```yaml
- { id: output-schema, type: schema, must_pass: true }
```

**`field`.** Checks values at paths in the envelope (`{ status, summary, artifacts, payload }`). All checks must hold. Paths use dots, `[n]` for an index and `[*]` for "every element". Operators: `exists`, `not_empty`, `equals`, `not_equals`, `contains`, `matches` (a JavaScript regular expression), `gte`, `lte`, `between` (`[min, max]`), `in`, `length_gte`, `length_lte`.

```yaml
- id: severity-valid
  type: field
  checks:
    - { path: "payload.issues[*].severity", op: in, value: [high, medium, low] }
```

With `[*]`, every matched node must pass. If `[*]` matches nothing (the array is empty), `exists`, `not_empty` and every comparison **fail**; only `length_gte` and `length_lte` still run, on the empty array itself. A check such as `payload.issues[*].severity` `in [...]` therefore fails when `issues` is empty.

**`reference`.** Compares the output with the case's `expected`. `mode: each_mentioned` needs an `expected` array of strings and scores the share found in the output text, ignoring case and extra whitespace (an empty array scores 1). `mode: equals` is deep equality. `path` defaults to `payload`, `pass_at` (0 to 1) defaults to 1.

```yaml
- id: finds-expected-issues
  type: reference
  weight: 3
  mode: each_mentioned
  path: payload.issues
  expected: expected.issues
```

A case with nothing at the `expected` path gets an error grade `EVAL_CASE_MISSING_EXPECTED`, not a failure, and is excluded from that grader's statistics.

**`rubric`.** A judge model grades the output against your words. `scale: pass_fail` (default) or `1_to_5` with `pass_at` (1 to 5, default 4). Optional `judge` overrides the default judge and up to 6 `examples` (`{ verdict: pass|fail, output, reason? }` for `pass_fail`; `{ score: 1-5, output, reason? }` for `1_to_5`) show the judge what each outcome looks like.

```yaml
- id: no-invented-files
  type: rubric
  weight: 2
  rubric: |
    Pass if every file named in the review exists in the diff.
    Fail if the review cites a file, function or line the diff does not contain.
  scale: pass_fail
```

The judge sees the rubric, the examples, the case input, the case `expected` if present, and the stage output. It must reply with JSON; a reply that is not JSON, or an HTTP error from the provider, becomes an error grade (`EVAL_JUDGE_ERROR`) that is left out of the score. 1-to-5 scores are normalized to (v-1)/4 for statistics; the raw value is stored too. Rubrics are **not calibrated**: nothing checks the judge against your own labels (see [What is not built](#not-built)). Pick a judge that is not the stage's model; if they match, validation warns (`eval.judge_same_as_stage`) because models tend to favor their own output.

**`code`.** The body of a JavaScript function that receives `(output, testCase, context)` where `output` is the envelope, `testCase` is the case, and `context = { evalId, runId, repeat }`. It returns a boolean, a number from 0 to 1, or `{ pass, score?, reason? }`. A number passes when it is at least `pass_threshold`. A thrown error, a bad return value or running past 5 seconds is an error grade (`EVAL_GRADER_CODE_ERROR`), not a failure.

```yaml
- id: no-false-alarms
  type: code
  weight: 2
  code: |
    return !testCase.tags.includes("no-issue") || output.payload.issues.length === 0;
```

`code` graders run JavaScript on your machine with your permissions, the same trust level as `verify: command`. Only run evals whose files you trust.

### How a case becomes a task

For each result Stageflow starts a normal stage run with this task: `goal` from the case's `goal`, else the eval's `task.goal`, else "Evaluate case <id>"; `context` and `constraints` from the eval's `task`; `input` from the case. No checkout or repository is set, so a stage that needs one cannot be evaluated yet (`eval.stage_needs_checkout` warns). A result whose stage run stops to ask the operator (a HITL gate) is recorded as an error `EVAL_STAGE_NEEDS_INPUT` and its stage run is cancelled (`eval.stage_has_gates` warns).

### Budget warnings

`budget: { latency_ms, cost_usd }` flags a result that is slower or costlier than the number. These are warnings shown on the result; they never fail it.

### Scoring

A result's **score** is the weighted mean of its graders' scores, leaving out `must_pass` graders and graders that errored. A result **passes** when no `must_pass` grader failed and the score is at least `pass_threshold`. A stage that failed, timed out or asked for input counts as a failed result, not as missing data. The **run** passes when it completed and its pass rate is at least `pass_threshold`.

## Datasets

A dataset is a file of cases in `datasets/` (or any root listed under `catalog.datasets`). The console edits `.dataset.jsonl`; `.dataset.json` and `.dataset.csv` load and run but are read-only in the console, which offers **Convert to JSONL**.

```jsonl
{"id":"c001","title":"Session token never expires","input":{"draft":"Users sign in with email and password. The server returns a session token that stays valid until the user signs out."},"expected":{"issues":["expir"]},"tags":["security"]}
{"id":"c003","title":"Clear export spec","input":{"draft":"The export button downloads the current table as a CSV file."},"expected":{"issues":[]},"tags":["no-issue"]}
```

| Key | Rule |
|-----|------|
| `id` | Required. `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, unique, stable (never renumbered) |
| `input` | Required object. Passed as the task input and checked against the stage's `io.input.schema` |
| `title` | Optional, up to 120 characters |
| `expected` | Optional, any JSON. Used by `reference` graders and shown to rubric judges |
| `tags` | Optional, up to 10 of `^[a-z0-9][a-z0-9-]{0,31}$`. Used to pick which cases a run uses |
| `goal` | Optional. Replaces the eval's `task.goal` for this case |
| `metadata` | Optional, free-form. Never read by Stageflow |

JSON files hold an array of cases or `{ "cases": [...] }`. CSV files use a header: `id`, `title`, `goal`, `tags` (split on `;`), `input.<name>`, `expected.<name>`, and any `:json` suffix to parse a cell as JSON.

- **Ids.** A hand-written file without ids is an error, so ids never drift. Uploads get `c001`, `c002`, ... in order.
- **Invalid cases are skipped.** A case whose `input` does not match the stage's `io.input.schema` is never run or graded. Validation warns (`dataset.input_mismatch`, `eval.cases_skipped`) and the run records how many were skipped. If none remain, the eval is invalid (`eval.no_valid_cases`).
- **Size.** Up to 5,000 cases, 1 MB per case, 50 MB per uploaded file. A small set gives wide error bars; fewer than 5 cases warns (`dataset.few_cases`).
- **In the console.** Upload a file (JSONL, JSON or CSV), paste text, add cases from past runs of the stage, or add a case by hand. Uploading maps each field of the stage's input schema to a column of your file and previews which rows are ready and which are skipped. The console always writes JSONL.

## Running an eval

Only **one eval run is active per Host**. A second start fails with `EVAL_RUN_ACTIVE`. Eval stage runs use the normal admission queue with no priority, so a large eval shares capacity with real runs; the default `concurrency` of 4 keeps that bounded.

- **Console.** Evals, then **Run** on a row (or **Run again** on a result). The dialog picks cases (all, failed last time, or hand-picked), repeats, cost limit, stage model and judge, and shows an estimate. Live progress shows results as they arrive; **Stop run** keeps the results so far. See [Console: Evals](console-evals.md).
- **CLI.** `sf eval run <id|path>`; see [CLI reference](cli-reference.md#sf-eval) and [CI](ci.md#evals-in-ci).
- **MCP.** `run_eval`, `get_eval_run`, `cancel_eval_run` and others; see [MCP](mcp.md#eval-tools).

A run needs the [engine](#the-engine) and a Host. `sf eval run` starts the shared global Host if nothing is listening.

### Cost control

Every run has a cost limit (`max_cost_usd`, default 2) covering stage runs and judge calls. When spending reaches it, the run stops with status `budget_stopped`, the remaining results are marked `skipped_budget`, and the run does **not** pass. Completed results are kept and their statistics are still computed, labeled incomplete.

The estimate in the run dialog is advisory: it uses the cost of the eval's last completed run, or the cost of the stage's last 20 non-eval executions. With no history it says so and the limit still applies. Judge cost is computed by Stageflow from the judge's token counts and the model catalog's prices; a model with no known price counts as $0 and the run shows that judge cost is unknown.

Limits: up to 5,000 results per run (cases x repeats), 10 repeats, concurrency 8. More than 500 results warns (`eval.large_run`).

### Timeouts

The Host does not enforce a stage's `timeout_ms` itself, so the eval runner does: after the stage's `timeout_ms` plus a 60 second safety margin (30 minutes when the stage sets none) it cancels the stage run and records `EVAL_STAGE_TIMEOUT` for that result.

## Reading results

The result page has four tabs: **Overview**, **Cases**, **Graders** and **Config**.

### Headline numbers

| Number | Meaning |
|--------|---------|
| **Pass rate** | Passed results divided by executed results. Errored results count as failed and are also reported separately |
| **95% CI (by case)** | A 95% confidence interval that treats **cases**, not results, as the independent units. Repeats of one case are alike, so counting them separately would make the interval too narrow. With few cases the interval is wide on purpose: 10 cases with 8 passing is `[50%, 100%]`, not `80%` |
| **Mean score** | Mean score of completed results; **spread** is how much a case's score varies between its repeats |
| **Reliability (pass^k)** | Share of cases that pass on **every** repeat. The honest number when you need the stage to work each time. Hidden when `repeats` is 1 |
| **pass@k** | Share of cases that pass on **at least one** repeat. Shows what the stage can do on a good try; it overstates how dependable it is |
| **Flaky cases** | Cases that passed on some repeats and failed on others. A single run on these is noise |
| **Latency p50 / p95 / slowest** | Over completed results |
| **Cost** | Stage cost plus judge cost, per result and in total; tokens in and out |

**Why repeats exist.** Models vary from one call to the next. One execution per case tells you what happened once. Several executions show how stable the stage is (reliability, flaky cases) and tighten the estimate.

### Graders tab and failure types

**By grader** shows each grader's pass rate, mean, range, errors and the change against the previous completed run (shown as "grader changed" when the grader's definition changed, because the two are not comparable). The case drawer shows the input, each repeat's output, every grade with its reason, and a **review**: mark the result Pass or Fail, add failure-type tags (tags are only for results that failed) and a one-sentence note. Reviews and tags are stored and summarized in the **Failure types** card. They are for your own triage; nothing uses them to check the judge.

### Compare

Compare two runs of the same eval (`sf eval compare <a> <b>`, or the Compare page). `a` is the baseline, `b` the candidate. The comparison is **paired by case**: both runs saw the same cases, so case difficulty cancels out. The verdict:

| Verdict | Meaning |
|---------|---------|
| `improved` | The 95% interval of the change excludes zero, on the positive side |
| `regressed` | The interval excludes zero, on the negative side |
| `no_clear_difference` | The interval includes zero. The console words this **inconclusive**: the data do not show a real change, in either direction |
| `insufficient_data` | Fewer than 5 cases in common |

An inconclusive result is not "no change"; it means this dataset cannot tell. The page also reports about how many cases would be needed to detect a 5 point difference. It lists what stayed the same (stage, model, dataset, graders, judge, repeats) and what changed, with a line diff of the system prompt when the stage differs. Warnings appear when the datasets or graders differ, because scores are then not comparable.

### Capability and regression evals

`type: capability` asks "can the stage do this?" and starts with a pass rate well under 100%. `type: regression` guards behavior that already works. The type is guidance only and changes no behavior. On the Evals list, a capability eval whose last run passed with a pass rate of 98% or more is **saturated**: it can no longer show improvement, so keep it as a regression eval and add harder cases to a new capability eval. Other list statuses are `never_run`, `passing`, `failing` and `regressed` (the last run failed and the one before passed).

## The engine

Results are executed and graded by [promptfoo](https://github.com/promptfoo/promptfoo), run as a pinned subprocess. It is **not** an npm dependency of Stageflow: it is installed on demand into `$STAGEFLOW_HOME/eval-engine/<version>/`.

```bash
sf eval engine status          # installed? which version? Node ok?
sf eval engine install         # npm install into $STAGEFLOW_HOME/eval-engine/0.124.0
```

- **Pinned version:** promptfoo `0.124.0`.
- **Node:** 22.22.0 or newer (Stageflow itself runs on Node 20 and up; only evals need the newer Node). Older Node fails with `EVAL_NODE_TOO_OLD`.
- **Size:** about 1.2 GB on disk and a one-time download. Install needs network access; running evals does not need promptfoo's servers.
- **Offline behavior:** after installation, only your own model providers are contacted. promptfoo's telemetry and remote features are blocked: the Host sets the disable flags and preloads a network guard that refuses connections to `*.promptfoo.app` and `*.promptfoo.dev`.
- **Missing engine:** the console shows a banner with the command, and a run start fails with `EVAL_ENGINE_UNAVAILABLE`.
- **Docker:** the image installs the engine at build time. See [Docker: eval engine](docker.md#eval-engine).

### Judge models

Rubric graders need a judge model. In this release only **`anthropic/…`**, **`openai/…` and `openrouter/…`** model ids can be judges. Any other provider is refused when the run starts (`EVAL_INVALID`, "supported judge providers are …"). The stage itself can use any provider.

The judge's key comes from a Pi `auth.json` entry of type `api_key` for that provider (the credential file the Host already uses; see [Providers](providers.md)), or else the environment variable of the same name: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. OAuth credentials (for example subscription tokens) are not API keys and cannot be used for judging. The key goes to the engine process through its environment and is never written into a config file or a result.

## Privacy and trust

- Running an eval sends **each case's input to the stage's model** as a normal stage run.
- For **rubric graders**, each case's input and the stage output are also sent to **the judge model's provider**.
- **Nothing is sent to promptfoo's services.** Telemetry and remote features are blocked.
- **`code` graders run JavaScript on your machine with your permissions**, the same trust level as `verify: command`.
- Results, outputs and your reviews are stored in the local run store ([Data directory](data-directory.md)). Stage runs started by evals are retained and purged like other runs.

## Known limitations

- **Stage fidelity for pipeline targets.** When you evaluate a stage of a pipeline, Stageflow rebuilds the stage from its own YAML (the `uses:` file or the inline entry) with the pipeline's model default. Pipeline-level overlays are **not** applied: entry-level `mcp`, `secrets`, `requires`, a wrapper `completion`, pipeline `channels` and `schemas`, and `include` merges. A stage that depends on those can behave differently under eval than inside its pipeline.
- **No checkout.** Cases run with no repository or checkout.
- **One run at a time** per Host.
- **Stage `timeout_ms`** is enforced by the eval runner with a 60 second margin (30 minutes when unset), not by the run manager.
- **Judge cost** is estimated from token counts and catalog prices; an unknown price counts as $0.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `EVAL_ENGINE_UNAVAILABLE` or "Eval engine not installed" | Run `sf eval engine install`. In Docker with an existing volume, run it inside the container |
| `EVAL_NODE_TOO_OLD` | Use Node 22.22.0 or newer for the Host. `sf eval engine status` shows the Node it sees |
| `eval.target_unresolved` ("does not load") | The target pipeline or stage file failed to load. For the sample, set a default `model:` in `stageflow.yaml` |
| `EVAL_INVALID` mentioning "supported judge providers" | The judge is not `anthropic/…`, `openai/…` or `openrouter/…`. Pick one of those, or remove the rubric graders |
| Rubric grades show `EVAL_JUDGE_ERROR` | No `api_key` credential or env var for the judge provider, a provider error, or a reply that was not JSON. Check the key and retry |
| `eval.judge_missing` | A rubric grader has no `judge` and the eval has no `defaults.judge` |
| Results show `EVAL_STAGE_NEEDS_INPUT` | The stage stopped at a HITL gate. Evals cannot answer gates; remove the gate or evaluate a stage without one |
| `dataset.input_mismatch` / cases skipped | Those cases do not match the stage's `io.input.schema` and are not run. Fix them on the dataset page |
| `EVAL_RUN_ACTIVE` | Another eval run is active on this Host. Wait or cancel it (`sf eval runs cancel <id>`) |
| Run ends `budget_stopped` | It reached `max_cost_usd`. Raise the limit with `--max-cost`, or run fewer cases or repeats. Completed results are kept |
| `EVAL_STAGE_TIMEOUT` | The stage ran past its `timeout_ms` plus 60 seconds. Raise the stage's `timeout_ms` or simplify the case |
| `FILE_CHANGED` when saving | The file changed on disk since it was loaded. Reload and reapply the edit |
| Engine work files needed for debugging | Set `STAGEFLOW_EVALS_KEEP_WORKDIR=1` to keep `$STAGEFLOW_HOME/eval-runs/<evalRunId>/` after a run (see [Environment variables](environment-variables.md)) |

Validation findings are listed in [YAML catalog: Evals](yaml-catalog.md#eval-validation-findings).

## HTTP API

The console uses these routes (all under the Host's `/api`, with the same auth as other routes). Eval runs are addressed by `eval_run_id` (`er_` plus 12 hex characters) or by eval id and run number.

| Route | Purpose |
|-------|---------|
| `GET /api/eval-engine` | Engine status |
| `GET /api/evals`, `POST /api/evals` | List (with status, banner, footer); create |
| `GET /api/evals/:id`, `PUT /api/evals/:id` | One eval with findings; save |
| `POST /api/evals/validate`, `POST /api/evals/try`, `POST /api/evals/sample` | Validate a draft; run one case; install the sample |
| `POST /api/evals/:id/runs`, `GET /api/evals/:id/runs/:n`, `GET /api/evals/:id/runs/estimate` | Start a run; read by number; estimate |
| `GET /api/evals/:id/failure-types` | Failure-type vocabulary |
| `GET /api/eval-runs`, `GET /api/eval-runs/:id`, `DELETE /api/eval-runs/:id` | List, read, delete runs |
| `GET /api/eval-runs/:id/results`, `…/results/:caseId`, `PUT …/results/:caseId/:repeat/review` | Result rows, one case, a review |
| `POST /api/eval-runs/:id/cancel`, `GET /api/eval-runs/:id/export` | Cancel; export |
| `GET /api/eval-compare?a=&b=` | Compare two runs |
| `GET /api/datasets`, `POST /api/datasets`, `GET /api/datasets/:id`, `PATCH /api/datasets/:id/cases`, `POST /api/datasets/:id/convert`, `POST /api/datasets/preview`, `GET /api/datasets/candidates` | Datasets |

## Not built {#not-built}

These are not part of this release:

- **`command` graders** (graders that run a command in a workspace).
- **Judge calibration.** Rubrics are shown as "Not calibrated": nothing checks the judge against your labels, and reviews are not used for that.
- **Agent evals.** Targets are stages only; the file format already carries a `kind` so agents can be added.
- **Pipeline evals** (evaluating a whole pipeline end to end).
- **CI triggers or scheduled eval runs.** `sf eval run` works in CI, but nothing starts evals on a schedule.
- **Editing an eval in the console.** The Edit page is not built yet; edit the YAML file directly.
- Synthetic data generation, production monitoring, red-teaming and deleting an eval from the console.

## See also

- [Console: Evals](console-evals.md)
- [YAML catalog: Evals](yaml-catalog.md#evals-eval-yaml)
- [CLI reference: `sf eval`](cli-reference.md#sf-eval)
- [MCP: eval tools](mcp.md#eval-tools)
- [CI: evals](ci.md#evals-in-ci)
- [Sample project](../examples/evals/README.md)
