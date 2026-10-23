---
status: draft-awaiting-owner-confirmation
---

# Epic: Evals for stages (release 1)

Written 2026-10-20 on Stageflow 0.38.0 (base commit 28bad4c6). Agents come later; release 1 must be built so agents extend it without a refactor.

This file is the epic. It holds every decision and the story index. The exact contracts are the `docs/specs/evals-*.md` files linked below. The work is split into stories in [docs/tickets/evals/](../tickets/evals/). Background research and rejected options: `docs/ideation/evals-scope.md` and `docs/ideation/evals-agent-chat-research-shelved/` (local only, gitignored).

## Problem statement

An author who writes a stage (a prompt, a model, an output schema) has no way to know whether it is any good, or whether a change made it better or worse. Stageflow can run a stage once. It cannot run it over many realistic inputs, grade the outputs, repeat to measure how stable it is, and compare two versions.

## Solution

An **eval** is a file in the project (`evals/<id>.eval.yaml`) that names a **target stage**, a **dataset** of cases (`datasets/<name>.dataset.jsonl`), a list of **graders** (exact checks and model-judged rubrics) and run defaults. The author runs it from the console, the CLI or MCP. Stageflow runs the stage on every case N times, grades every output, stores the results in the run store, and shows pass rate with honest error bars, per-grader scores, failures grouped by type, flaky cases, cost and time, and a compare view between two runs. Everything in the file is also editable in the console, and saving rewrites the file.

Engine: [promptfoo](https://github.com/promptfoo/promptfoo) runs as a pinned subprocess behind a Stageflow-owned `EvalEngine` interface. The console reads only Stageflow's own result tables.

## How to work on this epic (rules for implementing agents)

1. Read this file, then the reference specs your story names, then the story. Do not skip the "Read first" list.
2. **Do not decide anything this epic already decides.** Decisions marked **A** are agreed with the owner. Decisions marked **P** are proposed and stand unless the owner changes them (the epic's status line says when they are all confirmed). Follow both.
3. **If your story needs a decision that is not written down, stop.** Add it under the story's "Open questions" and ask the owner. Do not pick a default and keep going.
4. Do only what the story's "What to build" says. "Out of scope" lists things that look related and are not yours.
5. The verification results in [Pre-build verification results](#pre-build-verification-results) are authoritative once story 00 fills them in. If a result contradicts a story, stop and ask.
6. Follow `AGENTS.md`: match surrounding code, no comments unless the logic is not obvious, run `npm test`, `npm run ui:test` and `npm run typecheck` before finishing, and update docs when behavior changes. UI work also follows `ui/AGENTS.md`.
7. Use the glossary words below. Do not invent synonyms (not "suite", "test run", "scorer", "metric").
8. When you finish: tick the acceptance boxes, set the story's status line, and list anything you could not do.

## Glossary

| Term | Meaning |
|---|---|
| **Eval** | The definition file `evals/<id>.eval.yaml`: target, dataset, graders, defaults. |
| **Target** | What an eval tests. Release 1: one stage. Later: an agent. A tagged reference (`kind`). |
| **Dataset** | A file of cases. |
| **Case** | One test input: `id`, `input`, optional `expected`, `tags`, `title`, `goal`, `metadata`. |
| **Repeat** | One execution of a case. Each case runs `repeats` times because models vary. |
| **Result** | One (case, repeat): the stage output plus its grades. A run of 24 cases × 3 repeats has 72 results. |
| **Grader** | One rule that scores a result. Types: `schema`, `field`, `reference`, `rubric`, `code`. |
| **Grade** | One grader's verdict on one result. |
| **Rubric** | A grader written in words and judged by a model. |
| **Judge** | The model that applies rubrics. |
| **Eval run** | One execution of an eval: all results, grades, stats, cost, and a config snapshot. |
| **Stage run** | The normal Stageflow run the engine starts for one result. Marked `origin = eval`. |
| **Config snapshot** | Everything that determined an eval run, stored with it and never edited. |
| **Fingerprint** | Hash of the config snapshot. |
| **Engine** | The component that executes results and grades them. Release 1: promptfoo. |

## Decisions

**A** = agreed with the owner in conversation. **P** = proposed here, stands unless changed.

| # | Decision | Status |
|---|---|---|
| A1 | Release 1 evaluates **stages**. Agents are not built, but nothing may block them (see "Agent extension rules"). | A |
| A2 | Evals live in the project catalog: `evals/*.eval.yaml`, `datasets/*.dataset.(jsonl\|json\|csv)`, listed by new manifest roots `catalog.evals` and `catalog.datasets`. | A |
| A3 | Datasets can also be added in the console (upload, paste, from past runs, sample). The console writes the same files. | A |
| A4 | Any connected provider may be the judge. No restriction on what datasets contain. | A |
| A5 | The author runs evals. No reviewer roles exist, so none are built. | A |
| A6 | Release 1 success: a nice UI, basic eval setup, the dummy dataset runs, standard stats are visible. | A |
| A7 | promptfoo is the engine, as a **pinned subprocess** behind a Stageflow `EvalEngine` interface. Results are normalized into Stageflow's schema. The UI reads only that schema. | A |
| A8 | Out of scope: pipeline-level evals, red-teaming, CI triggers, channels, production monitoring, synthetic data, human annotation workflows beyond failure-type tags. | A |
| A9 | Everything the YAML can set is editable in the console. Saving rewrites the file. A Form/YAML toggle and a live diff exist. Past runs keep their snapshot. | A |
| A10 | Release 1 does **not** build: the YAML code-editor mode itself (the toggle, diff and file rewrite are built; the editor with inline validation is not), change-target/change-dataset pickers beyond reusing the New eval pickers, and the "Label more" calibration flow. Rubrics ship as "Not calibrated". | A |
| A11 | Stats follow the standards researched on 2026-10-20: clustered confidence intervals, repeats, pass^k vs pass@k, flaky-case detection, paired compare, judge-same-as-stage warning, config snapshot, capability vs regression type, failure-type tags. Formulas are in [result-schema.md](evals-result-schema.md). | A |
| P1 | **The engine is not an npm dependency of Stageflow.** It is installed on demand into `$STAGEFLOW_HOME/eval-engine/<promptfoo-version>/` with `sf eval engine install` (needs Node ≥ 22.22 and network once). The Docker image installs it at build. The console shows "Eval engine not installed" with the command when missing. Reason: promptfoo is large, needs Node ≥ 22.22 while Stageflow declares ≥ 20, and most users will not run evals. | P |
| P2 | **Each result runs as a real stage run** (so it is inspectable like any run), marked `runs.origin = 'eval'` and **hidden from the Runs list, Inbox and Overview by default.** | P |
| P3 | Release 1 grader types: `schema`, `field`, `reference`, `rubric`, `code`. **`command` graders are not in release 1** (they need a workspace and a sandbox). The New eval design lists "Command" in its grader-types panel; remove it (see design deltas). | P |
| P4 | Scoring rules in [result-schema.md](evals-result-schema.md#scoring): one `pass_threshold` is used for each result and for the run; stage errors count as failed results; 1–5 rubric scores normalize as (v−1)/4. | P |
| P5 | The console edits only `.dataset.jsonl` files. `.json` and `.csv` datasets load and run but are read-only in the console, with a "Convert to JSONL" action. Uploaded files are converted to JSONL on import. | P |
| P6 | Paths inside an eval file are **relative to the eval file's directory** (the same rule as `uses:` in pipelines). | P |
| P7 | A result whose stage run stops to ask the operator (HITL gate) is recorded as an error `EVAL_STAGE_NEEDS_INPUT`, its stage run is cancelled, and validation warns when the target stage declares `gate_kinds`. | P |
| P8 | `sf eval run` exit codes: `0` run completed and passed; `1` anything else (below threshold, failed, cancelled, stopped by budget, invalid eval, engine missing). JSON carries the detail. This matches the `0/1` convention of `sf run`. | P |
| P9 | **One eval run at a time per Host.** A second start returns `409 EVAL_RUN_ACTIVE`. Eval stage runs use the normal capacity queue with no priority; the default eval `concurrency` is 4. | P |
| P10 | The case drawer's **review** (Pass/Fail label, a one-sentence note, failure-type tags) and the "Failure types" card are in release 1 and stored (`eval_result_reviews`, `eval_result_tags`). Nothing uses the labels to check the judge yet (A10), and the drawer does not mention calibration. | P |
| P11 | Limits: ≤ 5,000 cases per dataset; ≤ 1 MB per case; ≤ 50 MB per uploaded file; ≤ 5,000 results per eval run (cases × repeats); `repeats` 1–10; `concurrency` 1–8. | P |
| P12 | In the console, **Evals is a nav item in the Build group**, between Catalog and the end of the group. The Wonder sidebars are older than the current nav and are not the source for the nav. | P |
| P13 | **Default roots.** When `catalog.evals` / `catalog.datasets` are absent from `stageflow.yaml`, the loader scans `evals/` and `datasets/` (relative to the project root) if they exist. Present keys override the defaults. `patterns.eval` defaults to `*.eval.yaml`; `patterns.dataset` accepts a string or an array and defaults to `["*.dataset.jsonl", "*.dataset.json", "*.dataset.csv"]`. The existing `exclude` list applies. | P |
| P14 | **The shipped sample eval uses no rubric graders** (schema, field, reference and code only), so it runs with any provider and needs no judge. Its stage has no `model:` and uses the project default. | P |
| P15 | **The case runner enforces its own safety timeout** because story 00 found the run manager does not enforce a stage's `timeout_ms`: after the stage's `timeout_ms` plus 60 s (30 min when the stage sets none) the runner cancels the stage run and returns `EVAL_STAGE_TIMEOUT`. Judge cost is computed by Stageflow from promptfoo's judge token counts and the model catalog's prices (promptfoo reports no judge cost); a model without a known price counts as $0 and the run shows "judge cost unknown". | P |

## Architecture

```
 eval file ─┐                                 ┌─ Host (sf ui / sf mcp) ───────────────────────────┐
 dataset ───┼─► loader + validator ─► EvalPlan│  EvalRunManager                                   │
 stage ─────┘     (src/config)       (src/evals)│    ├─ persists eval_runs / results / grades        │
                                               │    ├─ budget + cancel + one-run-at-a-time         │
 console / CLI / MCP ──► API ─────────────────►│    └─ calls EvalEngine.run(plan, io, signal)      │
                                               │                                                   │
                                               │  EvalEngine (interface)                           │
                                               │    ├─ FakeEngine        (tests, deterministic)    │
                                               │    └─ PromptfooEngine   (subprocess)              │
                                               │         ├─ writes promptfooconfig + provider      │
                                               │         ├─ provider ──HTTP──► Host: run-case ─────┼─► stage run (origin=eval)
                                               │         └─ judge calls go straight to the model   │
                                               └───────────────────────────────────────────────────┘
```

One eval run, step by step:

1. **Start.** API/CLI/MCP asks `EvalRunManager.start({eval, overrides})`. The manager loads the eval, dataset and target stage, validates them, builds the **EvalPlan** (resolved graders, cases, settings), computes the **config snapshot** and **fingerprint**, inserts an `eval_runs` row (`queued`), and starts the engine.
2. **Execute.** For each (case, repeat) the engine asks the Host to **run the case**: the Host starts a stage run (marked `origin = eval`) and returns the envelope, usage, latency and the stage run id. The Host enforces the cost limit and cancel here.
3. **Grade.** The engine applies every grader to the result. `schema`, `field`, `reference` and `code` graders run locally; `rubric` graders call the judge model.
4. **Normalize.** Each result and grade is converted to Stageflow's own shape and handed to the manager through `onResult`. The manager persists it immediately (so progress is live and a crash loses little).
5. **Finish.** The manager computes the run summary, stores it, and sets the final status (`completed`, `failed`, `cancelled`, `budget_stopped`).
6. **Read.** The console polls the eval run endpoints. Stats are computed from the tables by `src/evals/stats.ts`.

## Agent extension rules (release 1 must follow these)

From the agent definition on main (`agents/<id>.agent.yaml`, revisions, sessions):

1. The target is a **tagged reference** (`kind: stage | agent`) in the eval file, tables, API and UI. Release 1 accepts only `stage`. For agents it will carry the agent id and revision.
2. A **case is a JSON object** and datasets are target-neutral. For a stage, `input` matches `io.input`. For an agent it would be a scenario or a message list.
3. One **runner interface**: `runCase(target, case, options) → CaseOutput` (envelope or transcript, tool calls, usage, latency, or an error). Release 1 ships only the stage runner.
4. Graders read a **normalized subject** (text, JSON payload, artifacts, messages, tool calls, usage), not a stage envelope. Release 1 builds the subject from an envelope; the grader code must not reach into the envelope directly.
5. **Result tables are target-neutral**: target kind and reference, target version hash, eval file hash, engine, config snapshot, case, repeat, output, usage, error, grades. No stage-only columns.
6. **Version everything an eval compares**: stage definition hash now, agent revision later.
7. The UI uses a **target picker with kinds**. Release 1 shows stages only.

## Release 1 scope

In: everything in the Wonder designs (list in [ui-map.md](evals-ui-map.md)) except the items in A10 and the design deltas below; the CLI `sf eval`; MCP tools; docs; an example project; tests.

Out: A8, A10, P3, and everything under "Deferred" in the story index.

## Design source and deltas

Designs are in Wonder file page `01a10d0c-ed8b-7da6-9e8d-e66daac1c0cd` (artboards, y=9300). The map from artboard to route, API and components is [ui-map.md](evals-ui-map.md). The designs are mockups with invented numbers. **Behavior comes from these specs; the designs show layout, copy and states.**

Deltas to apply when building (and, where marked, to fix in Wonder):

1. Remove "Command" from the grader-types list and the Add grader menu (P3). *Fix in Wonder.*
2. Case score example "79%" in the Graders step's "Try on one case" panel does not follow P4's normalization; with a clarity score of 4/5 it is 75%. Numbers in designs are illustrative; do not copy them. *Optional Wonder fix.*
3. Calibration chips ("Calibrated 88%", the Judge calibration card, "Label more", "Re-check judge") are **not built** (A10). Every rubric shows "Not calibrated". The card is absent in release 1.
4. The Edit eval page's "YAML" tab is built as a read/write text view of the file with save-time validation errors only (A10 excludes the inline-validating editor).
5. Sidebar and nav in the artboards differ from the current console nav (P12). Use the real shell (`ui/src/redesign/shell/`).
6. Artboards use dark mockup tokens (`--sf-*`). Build with the console's existing tokens and Astryx rules in `ui/AGENTS.md`, not by copying artboard classes.

## Story index

Order is by dependency. Stories in the same row of "Can run in parallel with" do not depend on each other.

| # | Story | Blocked by | Parallel with |
|---|---|---|---|
| 00 | [Pre-build verification of engine unknowns](../tickets/evals/00-pre-build-verification.md) | none | 01, 02, 03 |
| 01 | [Catalog roots for evals and datasets](../tickets/evals/01-catalog-roots.md) | none | 00 |
| 02 | [Eval file loader and validator](../tickets/evals/02-eval-file-loader-and-validator.md) | 01 | 03, 04 |
| 03 | [Dataset loader, validator and hashing](../tickets/evals/03-dataset-loader.md) | 01 | 02, 04 |
| 04 | [Run store: eval tables and `runs.origin`](../tickets/evals/04-run-store-eval-tables.md) | none | 02, 03 |
| 05 | [Stats module (pure)](../tickets/evals/05-stats-module.md) | none | 02, 03, 04 |
| 06 | [EvalPlan, config snapshot, fingerprint](../tickets/evals/06-plan-snapshot-fingerprint.md) | 02, 03 | 05 |
| 07 | [EvalEngine interface and FakeEngine](../tickets/evals/07-engine-interface-and-fake.md) | 05, 06 | 08 |
| 08 | [Host stage case runner](../tickets/evals/08-host-stage-case-runner.md) | 00, 04, 06 | 07 |
| 09 | [EvalRunManager](../tickets/evals/09-eval-run-manager.md) | 04, 05, 06, 07, 08 | 10 |
| 10 | [Engine locator, installer, telemetry guard](../tickets/evals/10-engine-locator-and-installer.md) | 00 | 02–09 |
| 11 | [PromptfooEngine](../tickets/evals/11-promptfoo-engine.md) | 00, 07, 08, 10 | 12 |
| 12 | [Eval and dataset write path](../tickets/evals/12-eval-and-dataset-write-path.md) | 02, 03 | 09, 10, 11 |
| 13 | [HTTP API](../tickets/evals/13-http-api.md) | 09, 11, 12 | none |
| 14 | [CLI `sf eval`](../tickets/evals/14-cli-sf-eval.md) | 13 | 15, 16 |
| 15 | [MCP tools](../tickets/evals/15-mcp-tools.md) | 13 | 14, 16 |
| 16 | [Console foundation: nav, routes, API client, Evals list, empty state](../tickets/evals/16-ui-foundation-and-list.md) | 13 | none |
| 17 | [New eval wizard (Setup, Graders, Review) and Try one case](../tickets/evals/17-ui-new-eval-wizard.md) | 16 | 18, 19 |
| 18 | [Datasets: detail page and upload dialog](../tickets/evals/18-ui-datasets.md) | 16 | 17, 19 |
| 19 | [Run dialog and live progress](../tickets/evals/19-ui-run-dialog-and-progress.md) | 16 | 17, 18 |
| 20 | [Results: Overview, Cases, Graders, Config tabs and case drawer](../tickets/evals/20-ui-results.md) | 19 | 21 |
| 21 | [Compare runs](../tickets/evals/21-ui-compare.md) | 19 | 20 |
| 22 | [Edit eval page (form, YAML view, diff)](../tickets/evals/22-ui-edit-eval.md) | 17 | 20, 21 |
| 23 | [Entry points: Catalog stage "Evaluate" and cross-links](../tickets/evals/23-ui-entry-points.md) | 16, 20 | 22 |
| 24 | [Docs, example project, skills](../tickets/evals/24-docs-example-skills.md) | 12, 14, 15 | 16–23 |
| 25 | [End-to-end test and release checklist](../tickets/evals/25-e2e-and-release.md) | all | none |

Deferred (not release 1, do not build): `command` graders (P3), judge calibration and labelling (A10), agent targets (A1), the inline-validating YAML editor (A10), CI/scheduled evals, pipeline evals, production monitoring, synthetic data, dataset balance indicator, "reference answer passes graders" check, an Artifact grader type, dataset edit for `.json`/`.csv` (P5), deleting an eval from the console.

## Testing decisions

- A good test asserts observable behavior: parsed structures, API JSON, CLI output and exit codes, tables' rows, computed numbers. It does not assert on markup or on internals.
- Everything runs against `FakeEngine` and fake stage runners in the normal suite. **No test calls a real model or the network.** The real promptfoo engine has an opt-in test gated by `STAGEFLOW_EVALS_SMOKE=1` (the same pattern as `STAGEFLOW_BROWSER_SMOKE`).
- Stats are tested with hand-computed fixtures (the numbers are written in the story).
- Fixtures: `tests/fixtures/evals/` (eval files), `tests/fixtures/datasets/` (datasets). Keep `examples/evals/` in sync.
- Tests that touch the store use the existing test setup that pins an empty `STAGEFLOW_HOME`.
- UI tests follow the repo's pure-function pattern (see `docs/specs/stage-run-log-panel.md`, "Testing Decisions"): put logic in pure functions beside the component and test those with `vitest`; do not add DOM testing libraries.

## Risks to watch

1. **Capacity.** Eval stage runs share the Host's agent slots. A large eval can starve real runs (P9). Mitigated by the concurrency cap; not by priority. Revisit after use.
2. **Cost.** A 24-case × 3-repeat eval is 72 stage runs plus judge calls. The cost limit (default $2) and the run dialog's estimate are the guard. The estimate is approximate (see [result-schema.md](evals-result-schema.md#cost-estimate)).
3. **promptfoo output shape and behavior** are unverified until story 00. Stories 10 and 11 are blocked by it on purpose.
4. **Node version.** Evals need Node ≥ 22.22 (P1). The Docker image uses Node 22; a local machine may not.

5. **Stage fidelity (found in story 08).** For the pipeline target form, the case runner rebuilds the stage body from the stage's own YAML (a `uses:` file or the inline entry). Pipeline-level overlays are **not** applied: entry-level `mcp`, `secrets`, `requires`, wrapper `completion`, pipeline `channels` and `schemas`, and `include` merges. A stage that depends on those can behave differently under eval than inside its pipeline. Release 1 accepts this and documents it (story 24); revisit if it bites.

## Pre-build verification results

Filled in by [story 00](../tickets/evals/00-pre-build-verification.md) on 2026-10-20 (Stageflow 0.38.0, base 28bad4c6). Experiments ran in a scratch directory outside the repo against a local stub server (`tests/fixtures/evals/stubJudgeServer.mjs`), with no provider keys. Host: macOS, Node 26.5.0 (also Node 24.17.0), npm 11.17.0. Wall-clock timings were taken while the machine had a load average above 60, so read CPU time, not wall time.

### Summary for the owner

- **Pin promptfoo 0.124.0** (MIT, `engines.node >=22.22.0`). 0.124.1 is only 12 days old on 2026-10-20.
- **Live results: use the CLI plus an `extensions` `afterEach` hook.** No library script is needed (item 2).
- **Judge-capable in release 1: `anthropic`, `openai`, `openrouter`** (verified against the stub). Everything else is not offered as a judge (item 7).
- **Capacity: `startRun` queues** (default queue 32), and rejects with `busy_capacity` only when the queue is full (item 11).
- **Nothing contradicts a decision (A1-A11) or (P1-P14).** Several spec sentences in the engine interface were wrong or unverified and are fixed there (list at the end). Surprises that change story work are marked **Surprise**.

### 1. Version and Node

- Pinned: **promptfoo 0.124.0**, published 2026-10-06T01:35Z, 14 days before the run. License **MIT**. `engines.node` is `>=22.22.0`. `dist/src/entrypoint.js` enforces it at runtime (`nodeEngineRange = ">=22.22.0"`, prints "promptfoo requires a supported Node.js runtime" and exits), so the minimum Node that runs `eval` is **22.22.0** by source.
- Run for real on **Node 26.5.0 and 24.17.0** (both ran the full eval). Node 20 and 22.x are not installed on this machine and the story allowed no other downloads, so those were **not executed**; the 22.22.0 floor comes from the entrypoint gate, not from a run.
- Install: `npm install promptfoo@0.124.0` into an empty directory with npm 11.17.0: **629 packages, 1.2 GB on disk** (`@openai` 311 MB, `@anthropic-ai` 233 MB, `@azure` 96 MB, `node-sql-parser` 88 MB; `promptfoo` itself is 32 MB), 52 s wall (22 s user CPU) on a loaded machine. **Surprise: 1.2 GB** is far larger than "large" suggests. Put it in the install docs and the Docker size note.
- npm 11 prints "install scripts not yet covered by allowScripts" for `esbuild`'s postinstall. promptfoo ran fine anyway (the esbuild binary comes from its platform package), so postinstall is not required and `--ignore-scripts=false` is unnecessary. Keep `--ignore-scripts` out of the command, or leave it as is; both work.
- Cold start of `promptfoo --version` is about 1.5 s of CPU (wall was 12-37 s under load).
- Evidence: `npm view promptfoo time engines license`; `node node_modules/.bin/promptfoo --version`; `sed -n 1,70p dist/src/entrypoint.js`.

### 2. Library vs CLI (decision: CLI plus `extensions` hook)

- The package exports `evaluate(testSuite, options): Promise<Eval>` (`dist/src/index.d.ts`, `export declare function evaluate`) and `Eval.toEvaluateSummary()`. `EvaluateOptions` includes `maxConcurrency`, `repeat`, `cache`, `timeoutMs`, `maxEvalTimeMs`, `showProgressBar`, `abortSignal`, and **`progressCallback(completed, total, index, evalStep, metrics)`**. The package `exports` map only exposes `.` and `./contracts`, so a script outside the install must import `dist/src/index.js` by absolute path or resolve it with `createRequire` from the install directory.
- Both per-result callbacks were observed to fire **live, once per result, after its assertions finished** (10 results, library mode, `maxConcurrency` 2):
  - `progressCallback` fires with `evalStep.test.vars`, `evalStep.testIdx`, `evalStep.repeatIndex` and the running total.
  - An **extension hook** (`extensions: ["file://ext.mjs:afterEach"]`) is called as `afterEach(context)` where `context = { test, result }` and `result` is the full graded result including `gradingResult.componentResults`. It fired for passes, assertion failures, provider errors and thrown assertions. The signature is `(context)`, not `(hookName, context)` when a function name is given after the colon. An `afterAll(context)` hook exists as well.
- The same `extensions` config works with the **CLI** (`promptfoo eval -c promptfooconfig.json`): the hook ran in the CLI process and logged the same per-result data. So the CLI alone satisfies live results.
- **Decision:** spawn the CLI (as `engine-interface.md` already says) and put `extensions: ["file://hooks.mjs:afterEach"]` in the generated config. The hook POSTs `{ caseId, repeatIndex, componentResults, failureReason }` for each result to the Host (same per-run token as the provider) or appends one line to an NDJSON file the Host tails. `results.json` at exit is the reconciliation source. Reasons: no deep-import of an internal path, one reproducible config file, the subprocess boundary of A7 stays, and the CLI gives the same live hooks. The "provider process calls back to the Host" fallback in the engine interface is **not needed**.
- Library mode would add `abortSignal` for graceful cancel, but the CLI dies on SIGTERM in 0.25 s anyway (item 9), so that is not a deciding factor.
- Evidence: scratch `run-lib2.mjs` and `ext.mjs` (afterEach and progress timestamps interleave per result); CLI run with the same `ext.mjs` writing `ext.log`.

### 3. Custom provider callback

- `file://provider.mjs` with `export default class { id(); async callApi(prompt, context) }` works. It POSTed to the local stub `/run-case` and returned `{ output, tokenUsage, cost, metadata }`.
- **Concurrency is honored:** with `-j 2` the stub saw at most 2 in-flight requests; with `-j 3` at most 3. The default is 4.
- **`{ error }` return:** recorded as an error (`failureReason` 2, `success` false, `score` 0, top-level `error` set, `gradingResult` null, **no assertions run**: the stub judge received no call for those tests). `{ error, metadata }` keeps the metadata under `response.metadata` and `metadata`.
- **One provider process / module instance is shared by all tests** (same `pid` for every request, module-level state persists; a `Map` counter incremented across tests). So global state in `provider.mjs` is shared and must be concurrency-safe. Do not rely on it for the repeat index (item 4).
- Evidence: scratch `provider.mjs`, stub log `route: run-case` lines with `pid`, `inflight`, `maxInflight`.

### 4. Repeats

- Express repeats with `--repeat N` (CLI), `evaluateOptions.repeat` / `options.repeat` (library), or per test `options.repeat`. Each test is expanded into N results.
- **The repeat index reaches the provider:** `context.repeatIndex` (0-based) and also `context.vars.__repeatIndex`. `context` keys seen: `vars, prompt, filters, originalProvider, test, logger, getCache, repeatIndex, testIdx, evaluationId`. A counter keyed by `caseId` also matched under concurrency 2-3, but it is **not needed and not safe**; use `context.repeatIndex`.
- **In the results the repeat index is not a field.** A result has `testIdx` (observed `caseIndex * repeats + repeatIndex`, undocumented), `vars` (without `__repeatIndex`), and whatever the provider returned in `metadata`. **The provider must echo `repeatIndex` and `caseId` in `metadata` on success and on error** (verified: `response.metadata` and `result.metadata` both carry it for `{error, metadata}` returns). Results appear in **completion order**, not `testIdx` order.
- **Surprise:** when an assertion throws (item 5) the whole `response` is dropped and the echoed metadata is lost. The Host already knows each (case, repeat) from its own `run-case` callback, so normalization keys on the Host's records and uses promptfoo only for grades; also wrap every generated assertion function in try/catch.
- Evidence: stub log `varsRepeat`, `repeatIndex`, `counter`; `out.json` columns `testIdx` / `response.metadata.repeatIndexSeen`.

### 5. Result shape

Saved fixture: `tests/fixtures/evals/promptfoo-results.json` (CLI `--output`, 12 results from 6 tests x 2 repeats: `c1`, `c2`, `c3` normal; `c-fail` provider error; `c-bad` judge returns non-JSON; `c-throw` assertion throws). Paths scrubbed to `/work` and `/engine`. The key is passed only through the `OPENAI_API_KEY` environment variable, so the file contains no secret.

- File top level: `evalId, results, config, shareableUrl (null), metadata, vars, runtimeOptions`. `results` is `{ version, timestamp, prompts, results[], stats }`. `stats` has `successes, failures, errors, tokenUsage, durationMs`.
- Per result (`results.results[]`): `testIdx, promptIdx, vars, success, score, failureReason, error, latencyMs, cost, tokenUsage, namedScores, response, gradingResult, metadata, testCase, provider, prompt`.
  - `failureReason`: **0 = none (passed), 1 = an assertion failed, 2 = error** (provider error or thrown assertion). Distinguish an error from a failed assertion with this field, **not** with `error`: top-level `error` also holds the *failure reason string* for a plain assertion failure.
  - Result-level `score` and `success` are a weighted mean of raw component scores (a 1-5 rubric next to a 0/1 check gives a meaningless mix). Ignore them; Stageflow scores from components (the manager owns scoring).
- Per grader: `gradingResult.componentResults[]`, each with `assertion.metric` (our `graderId`), `pass`, `score`, `reason`, `tokensUsed`, `metadata` (and `assertion.type`). `gradingResult.namedScores[metric]` is the same score. Use **`metric` to join** a component to a grader. Reasons and scores are verbatim (raw 3 stayed 3; item 6).
- Provider usage and cost: `response.tokenUsage {prompt, completion, total, numRequests}` and top-level `cost` (the provider's `cost` field, 0.0123 in the fixture), plus our own `response.metadata`.
- Judge usage: `componentResults[].tokensUsed {total, prompt, completion, numRequests}` and the result-level `tokenUsage.assertions`. **There is no judge cost field.** Stageflow must compute judge cost from tokens times catalog price (Pi's model catalog has `cost.input` / `cost.output`).
- **Provider error:** `failureReason 2`, `error: "<code>: <message>"`, `response: { error, metadata }`, `gradingResult: null`, `namedScores: {}`.
- **Assertion that throws:** `failureReason 2`, `error` = the stack trace string (with absolute paths), `gradingResult: null`, **no `response`**, `metadata.errorContext` only. Treat as `EVAL_ENGINE_ERROR`, store no stack.
- **Judge returns non-JSON:** component `pass false`, `score 0`, `reason "Could not extract JSON from llm-rubric response"`, `metadata.graderError true`, `failureReason 1`. **Judge HTTP error (500 in the stub):** same shape, `reason` = `"API error: 500 Internal Server Error\n<response body>"`, `graderError true`. **Surprise:** that reason contains the **upstream response body**. The channels rule ("never a response body in an error") applies: for `graderError` store an error code, never `reason`.
- **Surprise (secret leak):** if the judge provider config contains `apiKey`, `results.json` repeats it in plaintext inside `componentResults[].assertion.provider.config` (the copy under `testCase` is redacted, that one is not). **Never put a key in the generated config**; pass it via the provider's environment variable (item 7). The fixture was generated this way and contains no key.
- Evidence: `tests/fixtures/evals/promptfoo-results.json`; exit code and shapes from scratch runs.

### 6. Rubric prompt and 1-5 scores

- A custom `rubricPrompt` on the `llm-rubric` assertion is **honored**. Nunjucks variables available: `{{rubric}}` (the assertion `value`), `{{output}}` (the provider output, JSON-parsed when it parses, rendered back as compact JSON), and every test `var` (we passed `input`, `expected`, `score_hint`). Verified from `componentResults[].metadata.renderedGradingPrompt`.
- promptfoo parses the judge reply as JSON (it extracts a JSON object from the text) and reads `pass` (default `true` if absent), `score` (any number; if absent it is `1` or `0` from `pass`), `reason`. With no `threshold` on the assertion, `pass` is exactly the judge's `pass`.
- **`score` is not clamped to 0-1**: a judge reply `"score": 3` came back as `componentResults[].score = 3` and `namedScores.quality = 3`. So a 1-5 raw value travels in `score`.
- **The reply format the Stageflow rubric prompt must demand:** `{"pass": true|false, "score": <integer 1-5 for 1_to_5, or 0/1 for pass_fail>, "reason": "<one sentence>"}` as the only content. Stageflow ignores the judge's `pass` and derives it from `score >= passAt`. A reply that is not JSON, or an HTTP error, comes back as `metadata.graderError true` and becomes a grade with `status: "error"`.
- Evidence: `renderedGradingPrompt` in the fixture; `matchesLlmRubric` / `runJsonGradingPrompt` in `dist/src/graders-CV4z-4HI.js`.

### 7. Judge provider mapping

Catalog ids are `provider/model`. Verified against the stub with `--no-cache` and the key in the environment only:

| Stageflow id | promptfoo provider string | Credential env var | Verified |
|---|---|---|---|
| `anthropic/<model>` | `anthropic:messages:<model>` | `ANTHROPIC_API_KEY` (base URL override `ANTHROPIC_BASE_URL`, tests only) | yes, stub received `x-api-key` from the env |
| `openai/<model>` | `openai:chat:<model>` | `OPENAI_API_KEY` (base URL override `OPENAI_BASE_URL`, tests only) | yes, stub received `Bearer` from the env |
| `openrouter/<rest>` | `openrouter:<rest>` (e.g. `openrouter:anthropic/claude-sonnet-4-5`) | `OPENROUTER_API_KEY`; base URL has **no env override**, only `config.apiBaseUrl` (smoke tests only) | yes |

- The provider prefix of the Stageflow id is stripped, the rest is the model. `openai:<model>` without `chat:` also hit `/chat/completions` in this version, but use the explicit `openai:chat:` form.
- A key passed through the environment did not appear in `results.json` (checked).
- **Not judge-capable in release 1** (no verified mapping; the picker's `judgeCapable` is false). Of the 42 providers Pi lists on this install: `amazon-bedrock` and `google-vertex` and `azure-openai-responses` (multi-part cloud credentials, not a single env key), `github-copilot` (promptfoo's `github:` is GitHub Models, a different service), `openai-codex` (OAuth, not an API key), `opencode` and `opencode-go` (promptfoo's `opencode:` is an agent SDK), `radius`, `omniroute`, `ollama`, `typesafe`, `ant-ling`, `baseten`, `kimi-coding`, `qwen-token-plan*`, `xiaomi*`, `zai*`, `cloudflare-*`, `minimax*`, `moonshotai*`, `meta`, `nvidia`, `huggingface`, `together`, `fireworks`, `cerebras`, `groq`, `deepseek`, `mistral`, `xai`, `google`. promptfoo has a native prefix and an `*_API_KEY` variable for many of these (`groq`, `mistral`, `deepseek`, `xai`, `togetherai`, `cerebras`, `huggingface` via `HF_TOKEN`, `google`, `fireworks`, `nvidia`), found by reading the package, but **none was run**, so they stay out until a later story verifies each.
- Credentials of type OAuth in `auth.json` (for example Anthropic subscription tokens) are not API keys; only `api_key` credentials may be exported to the subprocess.
- Evidence: scratch `judges-cfg.json` plus stub log lines with `route`, `model`, `auth`; provider list from `ModelRuntime.getProviders()`; prefixes from `startsWith("...")` entries in `dist/src/providers-bUp-0IzE.js`.

### 8. Telemetry guard

Network spy preloaded with `NODE_OPTIONS=--require spy.cjs` (wraps `dns.lookup`, `net.Socket.connect`, `fetch`, `http(s).request`). The guard variant rejects hosts matching `*.promptfoo.app` and `*.promptfoo.dev`.

| Run | Hosts contacted besides the local stub |
|---|---|
| no flags, no guard | `a.promptfoo.app`, `r.promptfoo.app`, `api.promptfoo.dev` |
| the four `PROMPTFOO_DISABLE_*` flags, no guard | `r.promptfoo.app` (one DNS lookup, one connect to 443, one fetch) |
| flags + guard | **none** (one `fetch` to `r.promptfoo.app` was attempted and rejected before any DNS lookup) |

The earlier finding stands: **the flags alone are not enough**. The guard must be installed through `NODE_OPTIONS=--require <guard.cjs>` (covers workers and child processes) as well as on the command line. Evidence: `spy-noflags.log`, `spy-flags.log`, `spy-guard.log` in the scratch directory.

### 9. Cancellation

SIGTERM and SIGINT sent to the promptfoo process while 2 provider calls were in flight (8 s stub delay):

- SIGTERM: exit code **143** in **0.24 s**. SIGINT: exit **130** in 0.27 s. No handler, no graceful drain.
- **No `--output` file is written** and no partial results. Anything the Host wants to keep must already have been streamed by the `afterEach` hook.
- No child processes (JS providers run in-process). The in-flight `/run-case` requests stay open on the Host side: the **Host must cancel the stage runs itself** (`cancelEvalRun` does) and answer or drop the pending callbacks.
- Safest sequence: SIGTERM, wait 5 s, then SIGKILL. It exits at once in practice; the wait is only a safety net.

### 10. Stage case execution (`RunManager`, run through `npx tsx` outside the repo tree, `FakeAgent`, `executionMode: "inprocess"`)

Test setup note: a real Host defaults to `executionMode: "process"` (stage workers); tests and my scratch used `inprocess` and a store opened with `openerMode: "migrate"`.

- (a) **Input validation.** `startRun({ pipeline: { id: "standalone-s1", stages: [stage] }, task: { id, goal, input } })` with an invalid `input` **throws `PipelineValidationError`** (`src/runtime/pipelineValidationError.ts`) rather than returning `{ ok: false }`. `err.result` is `{ scope: "pipeline", ok: false, summary: {errors: 1, warnings: 0}, findings: [{ severity: "error", code: "task.invalid_shape", path: "task.yaml", message: "Task input does not match entry stage \"s1\" io.input: payload.q must be string", category: "task", pipelineId, stageId }] }`. The check is `checkTaskEntryInput` (`src/runtime/taskInput.ts`) called from `runManager.ts` (line ~3079) against the entry stage's `io.input.schema`. `run_stage` catches the same error and returns "Stage validation failed". The eval runner must catch it and record `EVAL_INVALID`-style per-case error.
- (b) **Waiting for completion.** `startRun` returns `{ ok: true, runId, done: Promise<PipelineRunResult>, queued?, queuePosition? }`. **Await `done`** (it also resolves for queued runs, via `ensureQueuedDone`). `run_stage` blocking mode instead polls the store with **`waitRun({ store, runId, timeoutMs, until: "any" })`** (`src/mcp/waitRun.ts`) and checks `isTerminalProjection` / `isWaitingProjection`. **Surprise:** `isTerminalProjection` is only `succeeded | failed`, so a `cancelled` run never counts as terminal for `waitRun`; and `done` resolves with `{ ok: false, outcome: "failed", reason: "wait cancelled" }` for a cancelled run. Use `done` and then read the real status from the store.
- (c) **Results after completion.** `store.readRun(runId)` returns a `RunDetail` with `status`, `finished_at`, `failed_stage_id`, `failed_reason`, `total_cost_usd` (omitted without usage), and `stages[]` (`StageSnapshot`): `stage_id`, `status`, `envelope` (`{ status, summary, artifacts, payload }`), `artifacts`, `cost_usd?`, `usage?: StageUsage`. `StageUsage` is `{ costUsd, models: { "<model>": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd } } }` (`src/types/usage.ts`). **Latency is not on the snapshot**: use `store.listStageExecutions(runId, stageId)` / `getLatestStageExecution`, whose `StageExecution` has `started_at`, `finished_at`, `status`, `verification_outcome`, `envelope`, `usage`, `cost_usd`. `FakeAgent` reports no usage, so token and cost values could only be confirmed from the types, not from a run.
- (d) **Stage that asks the operator.** The run stays `status: "running"`; `waiting_stage_id` / `waiting_stage_ids` are set, the stage is `waiting_for_input` with `pending_prompt`; `getActiveCount()` stays 1. Cancel with `manager.cancelRun(runId, "eval_needs_input")` -> `{ ok: true, runId }`; the run becomes `cancelled` with `cancel_reason` set, `done` resolves (`ok: false`, `reason: "wait cancelled"`), and the active count drops to 0.
- (e) **Failures.** All end with `done = { ok: false, outcome: "failed", reason }` and run `status: "failed"`, `failed_stage_id`, `failed_reason`, stage `failed`: agent throw -> reason is the message ("boom"); no envelope emitted -> "missing emit_stage_envelope"; envelope `status: "failure"` -> "status: failure" (the envelope is kept); malformed payload -> "payload must be an object when present" (no envelope kept). Verification outcome is `StageExecution.verification_outcome` (`not_run` in these cases). **Timeout:** the manager does not enforce `timeout_ms`; it is passed to the agent adapter as `timeoutMs` (`stageAttemptBootstrap.ts` ~789). A fake agent that never returns ran past a 500 ms `timeout_ms` for more than 6 s. So `EVAL_STAGE_TIMEOUT` must be derived from the real adapter's failure reason, or from a `done` race with the stage's `timeout_ms` if the real adapter's reason text is not distinguishable. Not verified with the real Pi adapter.
- Not verified here: `on_verify_fail` loops and real token/cost numbers (need a real agent).
- Note: a stage's `io.input.schema` is only checked against `task.input`, so an eval stage without an input schema accepts any case `input`.

### 11. Capacity behavior (`RunManager.startRun`)

Three scenarios with a gated agent (two runs hold the slots until released):

- `maxConcurrent 2`, `maxQueued 32` (the default is 32, `STAGEFLOW_MAX_QUEUED`; Host default `maxConcurrent` is 3): 6 `startRun` calls all returned `ok: true`: two immediate, then `{ ok: true, queued: true, queuePosition: 1..4 }`. Store status of the queued four was `queued` while the first two were `running`. Peak concurrent agent work was 2. After release all six succeeded and every `done` resolved.
- `maxQueued 0`: calls 3 and 4 returned `{ ok: false, status: 409, code: "busy_capacity", reason: "Capacity full: 2/2 active runs", scope: "global", activeCount, maxConcurrent, activeRunIds }`.
- `maxQueued 1`: call 3 queued (position 1); calls 4 and 5 returned `{ ok: false, status: 409, code: "busy_capacity", reason: "Admission queue full: 1/1 queued runs" }`.
- **How a queued run starts:** `drainAdmissionQueue()` starts the next queued run when a slot frees (`startDequeuedAdmission`). **The caller learns by awaiting `done`** (or by polling the store: `queued` -> `running`). Other per-project/caller/checkout limits can also return `busy_checkout` or `busy_caller_quota` (eval runs have `caller_id = null`).
- **To run 50 cases with concurrency 4 politely:** the runner keeps its own semaphore of `plan.concurrency` and starts a case only when a permit is free, so it never fills the 32-slot queue (which real runs share). It awaits `done`. It treats `ok:false` with `code: "busy_capacity"` as retryable (back off 1-5 s, retry, do not count it as a case failure) and everything else in the `ok:false` family as a per-case error. Queued cases cancel through `cancelRun` like running ones.

### 12. Run list call sites (for story 04's `origin` filter)

Every display path that lists or counts runs ends in `RunStore.listRuns(filter)` (`src/runstore/port.ts:628`, `SqliteRunStore.listRuns` at `src/runstore/sqlite/SqliteRunStore.ts:1240`; `ListRunsFilter` has `status`, `since`, `pipeline`, `caller_id`) or `listRunOverviewRows` (`SqliteRunStore.ts:1289`). **Display sites (exclude `origin = 'eval'` by default):**

| Surface | File and function |
|---|---|
| HTTP `GET /api/runs` (feeds the whole console) | `src/server/http.ts:611` handler |
| Overview summary `GET /api/overview` | `src/server/http.ts:3536` -> `store.listRunOverviewRows(since)` -> `buildOverview` (`src/runstore/overviewSummary.ts`) |
| MCP `list_runs` | `src/mcp/catalogTools.ts:384` |
| MCP resource list for runs | `src/mcp/resources.ts:25` |
| MCP waiting gates / Inbox gates (`list_waiting_gates`-style tools in `controlTools.ts`:45,65 and `sf runs` gates at `src/cli/runsCommand.ts:550`) | `projectWaitingGates` in `src/mcp/waitingGates.ts:120` |
| CLI `sf runs` | `src/cli/runsCommand.ts:485` |

**UI:** the Runs page, Inbox, the sidebar "Pipeline runs" `inFlight` badge, per-pipeline / per-task / per-stage counts, trigger and catalog stats, the command palette and the start-run dialog all read one cached `CatalogSnapshot` filled by `fetchRuns()` (`ui/src/api/client.ts:118`, used only in `ui/src/catalog/httpSource.ts`) = `GET /api/runs`. So filtering at `GET /api/runs` covers every console surface; no per-page UI change is needed except an opt-in way to show eval runs.

**Operational sites that must keep seeing eval runs (do not filter):** `RunManager.attachWaitingStages` (`runManager.ts:875`), startup reconcile (`:994`), `resumeStalledSchedules` (`:1226`), queue rebuild (`:1251`, `status: "queued"`), `runRetentionSweep` (`runRetentionSweep.ts:327,384`, so eval runs get slimmed and purged), `exportAllCommand.ts:197`, `diagnostics/checks.ts:85`. Direct fetches by id (`GET /api/runs/:id`, `get_run`) must still return eval runs so a result can link to its stage run. `src/server/triggerRoutes.ts` lists trigger fires (a separate table), not runs.

### 13. Eval stage runs in storage

For an inline `standalone-<stageId>` run (fake agent, so no Pi session and no artifacts):

- Per run, SQLite rows: `runs` 1, `stages` 1, `stage_events` 7, `stage_executions` 1 (5 runs gave 5/5/35/5). No other table grows.
- Workspace directory: `<store>/runs/<runId>/stages/<stageId>/attempts/1/` with two small files (`declared-secrets.json`, `redaction-secrets.json`): about 8 KB per run on disk, 40 KB for 5 runs.
- Database: a fresh store is about 4 KB plus WAL; 5 runs grew the WAL by about 2 MB before a checkpoint. A real stage adds the Pi session log and any artifacts, which this fake agent cannot show; measure a real one before writing retention advice. A 24-case x 3-repeat eval is 72 runs: 72 `runs` rows, 504 `stage_events` rows and about 0.6 MB of workspace files for the fake case.
- The retention sweep already covers these runs (item 12).

### Changes made to other specs

`evals-engine-interface.md`: every "(verify: 00)" marker was replaced with the verified fact; the spawn command, live-result mechanism (afterEach hook instead of a provider callback), generated config rules (no key in config, never-throwing assertions, provider echoes `repeatIndex` and `caseId`), judge mapping table, rubric reply format, normalization notes and install notes were updated. No decision in this epic is contradicted.
