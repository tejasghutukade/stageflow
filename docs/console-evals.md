---
layout: default
title: Console - Evals
---

# Evals in the console

Evals live in the **Build** group of the sidebar, after Catalog. This page walks each screen in order. For what an eval is and how to read the numbers, see [Evals](evals.md). Agent evals use the same screens with a few additions, marked **Agent** below; the concepts are in [Evals for agents](evals.md#evals-for-agents).

| Route | Screen |
|-------|--------|
| `#/evals` | Evals list, or the empty state when there are no evals |
| `#/evals/new` | New eval wizard. `?pipeline=<path>&stage=<id>` or `?file=<path>` preselects a stage; `?agent=<id>` preselects an agent |
| `#/evals/<id>` | Opens the eval's live run when one is queued or running, else its newest run, or the edit page when it has no runs |
| `#/evals/<id>/runs/<n>` | Run results (`?tab=overview`, `cases`, `graders` or `config`), or live progress while the run is running |
| `#/evals/<id>/runs/<n>/case/<caseId>` | Run results with the case drawer open (`?repeat=<i>`; `?tab=transcript` for an agent eval) |
| `#/evals/<id>/compare?a=<n>&b=<m>` | Compare two runs |
| `#/evals/<id>/edit` | Edit eval (see [below](#edit-eval)) |
| `#/datasets`, `#/datasets/<id>` | Datasets |

The console reads only Stageflow's stored results. It formats numbers and never computes statistics itself.

## Evals list (`#/evals`)

One row per `*.eval.yaml` in the project. Columns: **Eval** (name and description), **Target** (a Stage chip, the pipeline and stage id or the stage file, and the path; an **Agent** chip with the agent's name, its revision `r<n>` and its model for an agent eval), **Dataset** (name, type, case count or scenario count, repeats), **Last run** (pass rate, change against the previous run in points, a bar), **Trend** (the last 7 completed runs: green passed, amber just under the threshold, red failed), **Cost / run** and **Status**.

Status is one of: **Never run**, **Running** (a run is queued or running), **Passing**, **Failing**, **Regressed** (the last run failed and the one before passed), or **Saturated** (a capability eval that passes 98% or more; the page suggests moving it to a regression eval and adding harder cases). An eval whose file does not validate shows **Needs fixing**.

- **Active run.** While a run is queued or running, the Last run column shows a pulsing link such as "Run #4 running · 12/48" that opens the live page, and the row opens the same page. Each dot in the Trend column opens that run; **Runs** under the dots opens the live run, or the newest one.
- **Filter tabs:** All, Stages, Agents and Regressed, plus a search box over id, name, stage, agent and dataset. `#/evals?agent=<id>` filters to one agent and shows a dismissible chip.
- **Regression banner.** When an eval regressed, a banner at the top names it, the pass rate before and after, how many criteria dropped, and links to **Compare runs**.
- **Engine banner.** When the eval engine is not installed, or Node is older than 22.22, a banner shows the reason and the command `sf eval engine install` with a copy button. **Run** actions stay available and show the server's message.
- **Keyboard.** Up and Down move the selection, Enter opens the eval.
- **Footer:** the number of evals, the number of datasets, and the cost of eval runs in the last 7 days.
- **Buttons:** **Datasets** and **New eval**.

### Empty state

With no evals, the page explains the idea in one line and offers **Try the sample eval** and **Create your own**. The agent sample is a separate install from the wizard's **Try sample data** tile once an agent is chosen: it creates a sample agent (`support_sample`, web chat off) and the `support-sample` eval with 6 scenarios, then opens its Run dialog; if it was already installed it just opens it. It needs a default `model` in `stageflow.yaml` (otherwise the console says to set one) and a host that can create agents (otherwise it says so). The sample copies the pipeline, eval and dataset from `examples/evals/` into your project's `pipelines/`, `evals/` and `datasets/` roots, then opens its Run dialog; if it was already installed it just opens it. The sample stage has no `model:`, so the project needs a default `model` in `stageflow.yaml` before it can run (otherwise validation reports `eval.target_unresolved`). Three cards describe the steps: pick a stage, add data, decide what good looks like.

## New eval (`#/evals/new`)

A three-step wizard: **Setup**, **Graders**, **Review and run**. Nothing is written until the last step. The eval is saved as `evals/<id>.eval.yaml`.

### Setup

- **Target.** A searchable list of the stages in your pipelines and standalone stage files, with each stage's model, the pipelines that use it and how many evals already target it. Selecting one shows the fields every case must have (from `io.input`). Opening the wizard from a stage preselects it. The **Stage | Agent** toggle switches the target kind.
- **Target (Agent).** A searchable list of the project's agents: name and id, model, revision, tool badges by kind (read, write, shell, external, unknown MCP, sub-agent), the tools that ask first, and how many evals already target it. Archived agents are greyed out; a disabled agent can be chosen and shows a chip, because evals run it anyway. Choosing one shows how many of its tools are not read-only and will be stubbed.
- **Dataset.** Four tiles: **Upload a file** (JSONL, JSON or CSV), **Paste or type**, **From past runs** (completed runs of the stage, excluding eval runs) and **Try sample data** (the 8 sample cases; disabled with a reason when they do not fit the selected stage). Once a dataset exists a summary card shows the file name, the case count, how many match the stage's input, where it will be written, and a preview of the first cases. The upload dialog maps your columns to the stage's input fields and previews which rows are ready or skipped. **Agent:** the tiles are **Upload a file**, **Paste or type**, **From past sessions** (finished sessions of the agent become script scenarios) and **Try sample data** (installs the sample agent and its 6 support scenarios as a ready eval, see above). The summary reads "n scenarios, all valid" or "k skipped". The upload dialog maps columns to Opening, Goal, Persona, Mode, Facts, Expected outcome, Expected tools, Forbidden tools, Title and Tags, and says "Scripts and tool mocks need a JSON or JSONL file."
- **Conversation (Agent only).** A card between the dataset and the run defaults: **Mode** (Script or Simulated), **Max turns** (1 to 30, default 8), **Turn timeout**, **User model** (simulated only; defaults to the judge), **Tools** (Read only, Mocked or Real), **Approvals** (Record only, Deny or Auto-approve reads) and **Read-only tools** (ids you declare safe; tools not listed are stubbed). A footer line says the eval's limits replace the agent's own for these runs and the agent file is not changed. Choosing **Real** shows a persistent warning ("Real tools can change your project") with an "I understand" checkbox that writes `allow_real_tools: true`; without it, **Create** is blocked.
- **Run defaults.** Repeats per case, judge model (only models from supported judge providers), pass threshold, cost limit, and **Capability** or **Regression**.
- **Right column.** A live YAML preview, a checklist of findings (errors and warnings) and "About $X per run", or "No cost history yet".

### Graders

The list of graders with an **Add grader** menu: Schema, Field check, Reference match, Rubric and Custom code. For an agent eval the menu hides Schema and adds **Tool calls** (must call, must not call, must ask first, max calls, argument checks), **Conversation check** (max turns, max questions per agent turn, final reply checks) and **Goal reached** (judge and guidance). Leave the tool lists empty to use each scenario's expected tools. Each grader is a card (type, id, weight, a "must pass" chip) that expands into that type's form; drag to reorder. Rubric cards show "Not calibrated". A **Budget** strip sets the latency and cost warnings. **Try on one case** runs the stage and all graders on a chosen case and shows the output summary, each grade and the case score; it makes real model calls. For an agent eval it runs one conversation and shows the **transcript** live (messages, tool calls with their outcome), the stop reason, the grades, cost and time; it can take a minute, can be cancelled, and honors the real-tools consent.

### Review and run

Name the eval (the id, validated against the id pattern and for uniqueness), add a description, check the summary (for an agent: the conversation settings, the stubbed-tools note and, for Real, the warning), the findings (errors block, warnings do not), the file path and the estimate, and read the final YAML. **Create eval** writes the dataset if it is new and then the eval. **Create and run** also opens the Run dialog. If the dataset is written and the eval is not, the message says so and the dataset is kept.

## Datasets (`#/datasets`)

A left rail lists datasets (name, case count, how many evals use it; the shipped sample has a "sample" chip). The detail page shows the format, the case count, the target stage, the path and when it was edited, and:

- An **invalid banner** when cases do not match the stage's input ("They are skipped in runs until fixed") with **Show invalid**.
- Tabs **All**, **Invalid** and **Tagged**, a **Table / JSONL** toggle, search and paging (25 per page).
- A table with one column per input field, up to two `expected` columns, **Tags** and **Input check** (Valid, or the reason).
- **Inline editing** of cells in JSONL datasets: leaving a cell saves it. If the file changed on disk the page says so and offers **Reload**. `.json` and `.csv` datasets are read-only with a **Convert to JSONL** action.
- **Upload cases**, **Add from runs** and **Add case** (id, title, one input per field, `expected`, tags). **Delete case** asks for confirmation.
- **Agent datasets.** A dataset used by an agent eval shows scenario columns (mode, title, opening or first message, expected tools, tags) and a scenario editor instead of the stage input form: persona, goal, opening and facts for simulated scenarios, a list of messages for scripted ones, expected outcome, tools and forbidden tools, and a table of tool mocks. Fields the effective mode ignores are collapsed. "Invalid" means scenarios skipped in runs until fixed. A dataset used by both a stage eval and an agent eval shows a banner that most rows will be invalid for one of them. **Add from runs** becomes **Add from sessions** for agents.

The footer reminds you that changes save to the file and that you should commit it to keep it in git.

## Run dialog and live progress

The Run dialog opens from a list row, **Run again** on a result, and the Catalog inspector. It shows the eval, stage, dataset and grader count and asks for:

- **Which cases:** All, **Failed last time** (needs a completed run) or **Pick cases**.
- **Repeats per case** (1 to 10), **Cost limit**, **Stage model** (the stage default first, then the catalog; try another model without editing the stage) and **Judge model**. The model fields are themed dropdowns with search, grouped by provider, keyboard navigable (arrow keys, Enter, Escape), with an amber hint when the judge is the same model as the stage. **Agent:** the field is **Agent model** ("Agent default" first), and **User model** appears when any scenario is simulated. The run always uses the agent's current revision shown in the subtitle; there is no revision picker. A read-only line summarizes the conversation settings (for example "Simulated, up to 8 turns, tools read only, approvals recorded"), and **Tools for this run** and **Approvals for this run** offer only options at least as safe as the eval's.
- **Compare with Run #n when it finishes**, on by default when a completed run exists. When more than one earlier run exists, "Compare with" becomes a dropdown of any earlier run, newest first, each with its status, pass rate and age; the newest completed run is preselected. Runs that did not complete are listed but cannot be chosen ("Only completed runs can be compared").
- An **estimate** with time, number of stage and judge calls, the run it is based on, and the stop limit. **Agent:** it counts conversations, simulator calls and judge calls, says "Rough estimate from typical conversations" when there is no history, and notes that a conversation that has started always finishes, so the limit can be passed by a little.
- **Real tools consent (Agent).** When the effective policy is Real, an amber panel repeats the warning and a required checkbox ("I understand this run can change files and call outside services") must be ticked before **Run eval** is enabled.

Errors from starting (`EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_ENGINE_UNAVAILABLE`) appear above the buttons. The dialog notes that the run uses this machine and your connected providers.

While a run is `queued` or `running` the run route shows **live progress** (the page scrolls, so every section is reachable on a short window): results graded so far, a stacked bar (passed, failed, running, queued), tiles for **Passing so far**, **Cost so far** against the limit, **Elapsed** and **Estimated left**, and a table of results as they arrive with each repeat's state and what the Host is doing now (stage running, judge grading, done, queued). For an agent eval the column says "Agent is talking" instead of stage running, and a failed repeat shows its reason ("Agent failed", "Timed out", "Simulator error"). **Stop run** asks you to confirm and keeps the results so far. When the run finishes the page switches to the results, or to Compare if you ticked the checkbox. A run that was stopped, failed or hit its cost limit opens with a banner stating the reason and that results are partial; a run that stopped after 5 consecutive provider failures says so (see [Evals: troubleshooting](evals.md#troubleshooting-agent-evals)).

The header of the live page and of the results has a **run switcher**: a button "Run #n" that lists up to 200 runs of the eval, newest first, with status (Queued, Running, Passed, Below threshold, Failed, Stopped, Cost limit), pass rate or progress, age and label. Pick one to open it; the current tab is kept.

## Run results

The header has the breadcrumb, a result chip (**Passed** or **Below threshold** with the pass rate against the threshold, or the run status for incomplete runs), and a subtitle with the stage, dataset, cases, repeats, judge and duration. The run number is the run switcher. Buttons: **Edit eval**, **Compare with #previous** (hidden for run 1; the Compare page has pickers for any two runs), **Export** (results as a file) and **Run again**. Tabs: **Overview**, **Cases**, **Graders** and **Config**. The footer shows the stage version hash, the eval file path, and previous and next run arrows.

### Overview

- A strip of KPI tiles: **Pass rate** (with the 95% interval by case), **Mean score** (with spread across repeats), **Reliability (pass^k)** (with pass@k and how many cases flip; hidden when repeats is 1), **Latency p50**, **Cost** and **Tokens**. **Agent:** two more tiles, **Turns** and **Tool calls** (means per conversation), and Cost splits into agent, simulator and judge.
- **By grader:** each grader's pass rate, mean, range and change against the previous run ("grader changed" when its definition changed).
- **Score per result:** a histogram with the threshold marked, and a note naming flaky cases.
- **Your verdict on judged grades:** the **Graders** tab shows a guided panel per judged grader: (1) **Label results** opens a full-screen label queue with the conversation, what the case wants, the rule, and big Pass/Fail buttons (keys `P`, `F`, `S`, arrows, `J`, `Esc`), the judge's answer hidden until you decide; (2) **Check the judge** gives a plain verdict and where it is too lenient or too strict; (3) **Teach it with examples** and **Try different wording** improve it. A case's drawer also has **Pass** and **Fail** buttons under each judged grade, and **Label more like this** opens the queue at that result. On the **Cases** tab, the **Any label status** filter has one **Needs my label · grader** entry per judged grader: it lists the cases with a result you have not labeled for that grader, and **Label these** opens the queue. Step 3 opens two dialogs: **Teach it with examples** (pick the wrong answers to turn into worked examples, edit each reason) and **Try different wording** (edit the rule, test it on the tuning rows and the fair-test rows, then save). See [Evals: Check the judge against your labels](evals.md#calibrate-judge).
- **Failure types:** counts of your failure-type tags on failed results, plus "Not reviewed yet". Click a tag to see those cases. The card header has the **Sort failures** button (next to it, the classifier it will use, such as "Jev · jev-1.13.0"). It is disabled while the run is active, when no result failed, or when no classifier is set up (the reason is shown). See [Evals: Sort failures automatically](evals.md#sort-failures).
- **Suggested:** below the Failure types card, once results are sorted. It shows pending, accepted and dismissed counts; one bar per bucket (Agent wrong, Grader wrong, Case wrong, Unclear) with what to fix; and a row per suggested failure type (click one to open the Cases tab filtered to it). **Accept all above 70% (n)** accepts every pending suggestion at or above 70% confidence; **Review suggestions (n)** opens the Cases tab filtered to **Needs review**, the pending low-confidence ones, which bulk accept never takes. If no classifier is available the section says how to add a TypeSafe key (Settings, Providers, or `STAGEFLOW_PROVIDER_TYPESAFE_API_KEY`) and offers **Sort with the judge model**. Nothing is tagged until you accept.
- **Failing and flaky cases:** the first five, with repeat dots, score, failed graders, time and cost; **All n cases** opens the Cases tab.

### Cases

Filter tabs **All**, **Failed**, **Flaky**, **Errored** and **Passed**, a grader filter, a tag filter, a suggested-bucket filter (**All buckets**, or one bucket), a **Needs review** checkbox, a removable chip for a suggested failure type picked in the Suggested section, and search, over all cases (25 per page). A row opens the case drawer; sorted cases show a bucket chip (low confidence is spelled out as "low 55%" and drawn dashed). For an agent eval the first column is the scenario title (or its opening message), with optional **Turns** and **Tools** columns.

### Graders

One row per grader with type, id, description, weight or must-pass, pass rate, mean, range, errors and change. Expanding a row shows its definition (the rubric text or the checks; for the agent graders, the tools, limits or guidance) and its five lowest-scoring cases; **Show all failing cases** opens the Cases tab filtered by that grader. Rubric graders also list the judge model, judge tokens and judge cost.

### Config

Everything that determined the run, so you can tell what a number means later: the fingerprint; the **Stage** (file or pipeline and stage, version hash with an amber "edited since" chip when the stage has changed, model, output schema; for an agent eval an **Agent** card instead: id, revision `r<n>` with "edited since: now r<m>" when the agent has changed, definition hash, model, a tools table with each tool's risk and the outcome the policy gives it, the tools that ask first, the effective limits and the sub-agents' revisions, plus a **Conversation** card with the mode, turns, timeouts, tool and approval policies, read-only tools, user model and prompt versions); the **Dataset** (file, content hash, "unchanged since this run" or "edited since", cases run and skipped); the **Graders** (id, kind, weight, hash, rubric version, "Not calibrated"); the **Run settings** (judge, repeats, threshold, limit and amount spent, type, software versions); and **Reproduce** with a copyable `sf eval run` command, **Export JSON** and **Re-run with these settings**. Re-run uses the run's repeats, judge, model override, cost limit and case subset. It cannot restore an older stage, agent, dataset or grader: if their hashes changed, an amber note says the current ones will be used. For a run that used real tools, the reproduce command includes `--allow-real-tools`.

### Case drawer

Opens from any case row (`…/case/<caseId>`) with previous and next arrows. It shows the title, a **Flaky** chip when the case gave different verdicts, and a tab for each repeat with its score. For the selected repeat: the **input**, the **output** (stage envelope with time, cost and tokens), an **expected** checklist when a reference grader exists (found or "not in output"), and **grades for this repeat** (each grader's verdict, score and reason; error grades show the error). Results that did not complete show the error code and message instead.

**Agent: Transcript tab.** For an agent eval the drawer opens on a **Transcript** tab in place of the output. Its header chips show the stop reason (Resolved, Gave up, Turn limit, Script ended, Repeated itself, Empty message), the number of turns and tool calls, time and cost. Messages are grouped by turn as user and agent bubbles, with long text scrolling and cut text marked "…[truncated N chars]". Under each agent message, **tool call chips** show the name, an outcome badge (**Ran**, **Stubbed**, **Mocked**, **Would ask first**, **Denied**) and the status; opening a chip shows the arguments and the result summary. When the scenario has `expected.tools` or `forbidden_tools` they appear as a checklist beside the chips (found, missing, or a forbidden tool called). **Open agent run** links to the agent's run page and its waterfall; it is replaced by "agent session deleted" once the session is gone, and the stored transcript still shows. A result that failed shows its partial transcript and the error in place of grades.

**Suggested sort.** For a failed result with a pending or accepted suggestion, a panel above the review reads "Jev suggests: agent wrong · missing_tool_call · 82%" (or "Judge model suggests"), with "false alarm on <grader>" when a grader is probably wrong. **Accept** writes the failure type and a `bucket:<bucket>` tag into your review; **Dismiss** hides the suggestion. A low-confidence one says "Low confidence: read this one yourself".

**Your review:** mark the result **Pass** or **Fail**, add failure-type tags (only on results that failed; **+ New tag** adds to the vocabulary) and a one-sentence note, then **Save review**. Reviews feed the Failure types card; they do not change the grades. The footer has **Open stage run** (the stage run's page, when it has not been purged; **Open agent run** for an agent eval) and **Re-run this case** (one stage run, or one conversation, plus grading; real model calls).

## Compare

**Compare runs** has **Before** and **After** pickers. From top to bottom:

- **What changed in the stage:** the stage version hashes, a line diff of the system prompt (12 lines, then **View full diff**) and which other keys changed. "Stage unchanged" when the hashes match. For two agent runs this reads **What changed in the agent**: the revisions (`r<a>` to `r<b>`), a line diff of the instructions and the other changed keys (model, tools, limits).
- **Held constant / Changed:** dataset, graders, judge and repeats against the stage. If the datasets or graders differ, the strip is amber and the warnings are listed, because the scores are not comparable. For agents the strip also names a changed tool policy, approval policy, mode, turn limit or user model. The KPIs add **Turns** and **Tool calls** deltas, shown for information with no verdict.
- **KPIs:** Pass rate (before to after, change in points, the 95% interval and a verdict: improved, regressed, inconclusive or not enough shared cases), Mean score, Flaky cases, Latency p50 and Cost per run.
- **By grader:** before, after and a change bar per grader; "changed" for graders whose definition differs.
- **Cases that changed:** tabs **Fixed**, **Regressed** and **Unchanged**, with before and after repeat dots and the score change. A row opens the drawer of the After run.
- A footer explains that differences are paired by case, that a change counts as real only when its interval excludes zero, and about how many cases are needed to detect 5 points.

## Edit eval {#edit-eval}

`#/evals/<id>/edit` changes everything in `evals/<id>.eval.yaml`. A **Form | YAML** toggle switches views; they stay in sync, and switching to Form with YAML that does not parse shows the errors instead. The form has the definition card (target, dataset, defaults), for an agent eval the Conversation card, and the graders list; a side panel shows a diff of the file against the saved version and the current findings. Change target, **Change agent** and **Change dataset** open pickers. The header has an unsaved-changes count and **Run** (the Run dialog; a banner offers it when there are no runs yet), and a "Run in progress" chip links to the live run.

**Save eval** is disabled until there are changes and no errors (warnings do not block). It rewrites the file; the footer notes that past runs keep the version they used. **Discard changes** asks first. If the file changes on disk while you edit, a banner offers **Keep editing** or **Reload from disk**, and saving stays off until you reload (`FILE_CHANGED`).

## Entry points elsewhere

- **Catalog.** Selecting a stage in **Catalog, Stages** shows an **Evals** section with the evals that target it (cases, last run, pass rate), **+ New eval** (preselects the stage) and an **Evaluate** button: it opens the eval's Run dialog if exactly one exists, the wizard if none, or the Evals list filtered to that stage if there are several.
- **Run detail.** A stage run started by an eval shows a banner, "This run was started by eval …, run #n", linking back to the result.
- **Agent page.** An agent's page has an **Evals** tab (with the count) listing the evals that target it, **+ New eval**, and an **Evaluate** button in the header (the Run dialog if there is one eval, the wizard with the agent preselected if none, the list filtered to the agent if several). A finished session has **Add as eval case** (disabled with a reason while it is running or has no messages, and absent for eval sessions), which lets you pick a new or existing dataset, previews the script scenario it would create and writes nothing until you confirm. Opening an eval session by link, on the session page or the run page, shows a banner "This session was created by eval …, run #n" with a link to the result.
- **Hidden from other lists.** Stage runs started by evals do not appear in the Runs list, Inbox or Overview, and eval sessions do not appear in an agent's session list, the Inbox or its counts ([Evals: eval sessions](evals.md#eval-sessions)).

## See also

- [Evals](evals.md)
- [Operator console](operator-console.md)
- [Console: Pipelines, tasks and catalog](console-pipelines-catalog.md)
