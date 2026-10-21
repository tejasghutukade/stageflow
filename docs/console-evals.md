---
layout: default
title: Console - Evals
---

# Evals in the console

Evals live in the **Build** group of the sidebar, after Catalog. This page walks each screen in order. For what an eval is and how to read the numbers, see [Evals](evals.md).

| Route | Screen |
|-------|--------|
| `#/evals` | Evals list, or the empty state when there are no evals |
| `#/evals/new` | New eval wizard. `?pipeline=<path>&stage=<id>` or `?file=<path>` preselects the target |
| `#/evals/<id>` | Opens the eval's latest run, or the edit page when it has no runs |
| `#/evals/<id>/runs/<n>` | Run results (`?tab=overview`, `cases`, `graders` or `config`), or live progress while the run is running |
| `#/evals/<id>/runs/<n>/case/<caseId>` | Run results with the case drawer open (`?repeat=<i>`) |
| `#/evals/<id>/compare?a=<n>&b=<m>` | Compare two runs |
| `#/evals/<id>/edit` | Edit eval (not built yet, see [below](#edit-eval)) |
| `#/datasets`, `#/datasets/<id>` | Datasets |

The console reads only Stageflow's stored results. It formats numbers and never computes statistics itself.

## Evals list (`#/evals`)

One row per `*.eval.yaml` in the project. Columns: **Eval** (name and description), **Target** (a Stage chip, the pipeline and stage id or the stage file, and the path), **Dataset** (name, type, case count, repeats), **Last run** (pass rate, change against the previous run in points, a bar), **Trend** (the last 7 completed runs: green passed, amber just under the threshold, red failed), **Cost / run** and **Status**.

Status is one of: not run yet, **Passing**, **Failing**, **Regressed** (the last run failed and the one before passed), or **Saturated** (a capability eval that passes 98% or more; the page suggests moving it to a regression eval and adding harder cases). An eval whose file does not validate shows **Needs fixing**.

- **Filter tabs:** All, Stages and Regressed, plus a search box over id, name, stage and dataset. An Agents tab is shown with a "soon" label and does nothing.
- **Regression banner.** When an eval regressed, a banner at the top names it, the pass rate before and after, how many criteria dropped, and links to **Compare runs**.
- **Engine banner.** When the eval engine is not installed, or Node is older than 22.22, a banner shows the reason and the command `sf eval engine install` with a copy button. **Run** actions stay available and show the server's message.
- **Keyboard.** Up and Down move the selection, Enter opens the eval.
- **Footer:** the number of evals, the number of datasets, and the cost of eval runs in the last 7 days.
- **Buttons:** **Datasets** and **New eval**.

### Empty state

With no evals, the page explains the idea in one line and offers **Try the sample eval** and **Create your own**. The sample copies the pipeline, eval and dataset from `examples/evals/` into your project's `pipelines/`, `evals/` and `datasets/` roots, then opens its Run dialog; if it was already installed it just opens it. The sample stage has no `model:`, so the project needs a default `model` in `stageflow.yaml` before it can run (otherwise validation reports `eval.target_unresolved`). Three cards describe the steps: pick a stage, add data, decide what good looks like.

## New eval (`#/evals/new`)

A three-step wizard: **Setup**, **Graders**, **Review and run**. Nothing is written until the last step. The eval is saved as `evals/<id>.eval.yaml`.

### Setup

- **Target.** A searchable list of the stages in your pipelines and standalone stage files, with each stage's model, the pipelines that use it and how many evals already target it. Selecting one shows the fields every case must have (from `io.input`). Opening the wizard from a stage preselects it. The Agent toggle is disabled ("soon").
- **Dataset.** Four tiles: **Upload a file** (JSONL, JSON or CSV), **Paste or type**, **From past runs** (completed runs of the stage, excluding eval runs) and **Try sample data** (the 8 sample cases; disabled with a reason when they do not fit the selected stage). Once a dataset exists a summary card shows the file name, the case count, how many match the stage's input, where it will be written, and a preview of the first cases. The upload dialog maps your columns to the stage's input fields and previews which rows are ready or skipped.
- **Run defaults.** Repeats per case, judge model (only models from supported judge providers), pass threshold, cost limit, and **Capability** or **Regression**.
- **Right column.** A live YAML preview, a checklist of findings (errors and warnings) and "About $X per run", or "No cost history yet".

### Graders

The list of graders with an **Add grader** menu: Schema, Field check, Reference match, Rubric and Custom code. Each grader is a card (type, id, weight, a "must pass" chip) that expands into that type's form; drag to reorder. Rubric cards show "Not calibrated". A **Budget** strip sets the latency and cost warnings. **Try on one case** runs the stage and all graders on a chosen case and shows the output summary, each grade and the case score; it makes real model calls.

### Review and run

Name the eval (the id, validated against the id pattern and for uniqueness), add a description, check the summary, the findings (errors block, warnings do not), the file path and the estimate, and read the final YAML. **Create eval** writes the dataset if it is new and then the eval. **Create and run** also opens the Run dialog. If the dataset is written and the eval is not, the message says so and the dataset is kept.

## Datasets (`#/datasets`)

A left rail lists datasets (name, case count, how many evals use it; the shipped sample has a "sample" chip). The detail page shows the format, the case count, the target stage, the path and when it was edited, and:

- An **invalid banner** when cases do not match the stage's input ("They are skipped in runs until fixed") with **Show invalid**.
- Tabs **All**, **Invalid** and **Tagged**, a **Table / JSONL** toggle, search and paging (25 per page).
- A table with one column per input field, up to two `expected` columns, **Tags** and **Input check** (Valid, or the reason).
- **Inline editing** of cells in JSONL datasets: leaving a cell saves it. If the file changed on disk the page says so and offers **Reload**. `.json` and `.csv` datasets are read-only with a **Convert to JSONL** action.
- **Upload cases**, **Add from runs** and **Add case** (id, title, one input per field, `expected`, tags). **Delete case** asks for confirmation.

The footer reminds you that changes save to the file and that you should commit it to keep it in git.

## Run dialog and live progress

The Run dialog opens from a list row, **Run again** on a result, and the Catalog inspector. It shows the eval, stage, dataset and grader count and asks for:

- **Which cases:** All, **Failed last time** (needs a completed run) or **Pick cases**.
- **Repeats per case** (1 to 10), **Cost limit**, **Stage model** (the stage default first, then the catalog; try another model without editing the stage) and **Judge model**, with an amber hint when the judge is the same model as the stage.
- **Compare with Run #n when it finishes**, on by default when a completed run exists.
- An **estimate** with time, number of stage and judge calls, the run it is based on, and the stop limit.

Errors from starting (`EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_ENGINE_UNAVAILABLE`) appear above the buttons. The dialog notes that the run uses this machine and your connected providers.

While a run is `queued` or `running` the run route shows **live progress**: results graded so far, a stacked bar (passed, failed, running, queued), tiles for **Passing so far**, **Cost so far** against the limit, **Elapsed** and **Estimated left**, and a table of results as they arrive with each repeat's state and what the Host is doing now (stage running, judge grading, done, queued). **Stop run** asks you to confirm and keeps the results so far. When the run finishes the page switches to the results, or to Compare if you ticked the checkbox. A run that was stopped, failed or hit its cost limit opens with a banner stating the reason and that results are partial.

## Run results

The header has the breadcrumb, a result chip (**Passed** or **Below threshold** with the pass rate against the threshold, or the run status for incomplete runs), and a subtitle with the stage, dataset, cases, repeats, judge and duration. Buttons: **Edit eval**, **Compare with #previous** (hidden for run 1), **Export** (results as a file) and **Run again**. Tabs: **Overview**, **Cases**, **Graders** and **Config**. The footer shows the stage version hash, the eval file path, and previous and next run arrows.

### Overview

- A strip of KPI tiles: **Pass rate** (with the 95% interval by case), **Mean score** (with spread across repeats), **Reliability (pass^k)** (with pass@k and how many cases flip; hidden when repeats is 1), **Latency p50**, **Cost** and **Tokens**.
- **By grader:** each grader's pass rate, mean, range and change against the previous run ("grader changed" when its definition changed).
- **Score per result:** a histogram with the threshold marked, and a note naming flaky cases.
- **Failure types:** counts of your failure-type tags on failed results, plus "Not reviewed yet". Click a tag to see those cases.
- **Failing and flaky cases:** the first five, with repeat dots, score, failed graders, time and cost; **All n cases** opens the Cases tab.

### Cases

Filter tabs **All**, **Failed**, **Flaky**, **Errored** and **Passed**, a grader filter, a tag filter and search, over all cases (25 per page). A row opens the case drawer.

### Graders

One row per grader with type, id, description, weight or must-pass, pass rate, mean, range, errors and change. Expanding a row shows its definition (the rubric text or the checks) and its five lowest-scoring cases; **Show all failing cases** opens the Cases tab filtered by that grader. Rubric graders also list the judge model, judge tokens and judge cost.

### Config

Everything that determined the run, so you can tell what a number means later: the fingerprint; the **Stage** (file or pipeline and stage, version hash with an amber "edited since" chip when the stage has changed, model, output schema); the **Dataset** (file, content hash, "unchanged since this run" or "edited since", cases run and skipped); the **Graders** (id, kind, weight, hash, rubric version, "Not calibrated"); the **Run settings** (judge, repeats, threshold, limit and amount spent, type, software versions); and **Reproduce** with a copyable `sf eval run` command, **Export JSON** and **Re-run with these settings**. Re-run uses the run's repeats, judge, model override, cost limit and case subset. It cannot restore an older stage, dataset or grader: if their hashes changed, an amber note says the current ones will be used.

### Case drawer

Opens from any case row (`…/case/<caseId>`) with previous and next arrows. It shows the title, a **Flaky** chip when the case gave different verdicts, and a tab for each repeat with its score. For the selected repeat: the **input**, the **output** (stage envelope with time, cost and tokens), an **expected** checklist when a reference grader exists (found or "not in output"), and **grades for this repeat** (each grader's verdict, score and reason; error grades show the error). Results that did not complete show the error code and message instead.

**Your review:** mark the result **Pass** or **Fail**, add failure-type tags (only on results that failed; **+ New tag** adds to the vocabulary) and a one-sentence note, then **Save review**. Reviews feed the Failure types card; they do not change the grades. The footer has **Open stage run** (the stage run's page, when it has not been purged) and **Re-run this case** (one stage run plus grading; real model calls).

## Compare

**Compare runs** has **Before** and **After** pickers. From top to bottom:

- **What changed in the stage:** the stage version hashes, a line diff of the system prompt (12 lines, then **View full diff**) and which other keys changed. "Stage unchanged" when the hashes match.
- **Held constant / Changed:** dataset, graders, judge and repeats against the stage. If the datasets or graders differ, the strip is amber and the warnings are listed, because the scores are not comparable.
- **KPIs:** Pass rate (before to after, change in points, the 95% interval and a verdict: improved, regressed, inconclusive or not enough shared cases), Mean score, Flaky cases, Latency p50 and Cost per run.
- **By grader:** before, after and a change bar per grader; "changed" for graders whose definition differs.
- **Cases that changed:** tabs **Fixed**, **Regressed** and **Unchanged**, with before and after repeat dots and the score change. A row opens the drawer of the After run.
- A footer explains that differences are paired by case, that a change counts as real only when its interval excludes zero, and about how many cases are needed to detect 5 points.

## Edit eval {#edit-eval}

`#/evals/<id>/edit` currently shows "Coming soon", and the **Edit eval** buttons lead there. Until it is built, change an eval by editing `evals/<id>.eval.yaml` directly; the next run records the new definition in its snapshot and past runs keep theirs.

## Entry points elsewhere

- **Catalog.** Selecting a stage in **Catalog, Stages** shows an **Evals** section with the evals that target it (cases, last run, pass rate), **+ New eval** (preselects the stage) and an **Evaluate** button: it opens the eval's Run dialog if exactly one exists, the wizard if none, or the Evals list filtered to that stage if there are several.
- **Run detail.** A stage run started by an eval shows a banner, "This run was started by eval …, run #n", linking back to the result.
- **Hidden from other lists.** Stage runs started by evals do not appear in the Runs list, Inbox or Overview.

## See also

- [Evals](evals.md)
- [Operator console](operator-console.md)
- [Console: Pipelines, tasks and catalog](console-pipelines-catalog.md)
