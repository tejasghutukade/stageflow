---
layout: default
title: Evals
---

# Evals

An **eval** answers one question about a stage or an agent: is it any good, and did my last change make it better or worse? It runs the target over many realistic inputs, grades every output, repeats each input to measure how stable the target is, and lets you compare two runs. A stage case is one input and one output; an agent case is a whole conversation (see [Evals for agents](#evals-for-agents)).

Evals are a general quality tool for configurable stages and agents. A stage that triages tickets, summarizes research, reviews a draft, classifies an email, writes release notes or checks an ops runbook can all be evaluated the same way. Nothing in an eval is specific to one domain.

An eval is a file in your project, `evals/<id>.eval.yaml`. It names a **target** (one stage, or one agent), a **dataset** of cases (`datasets/<name>.dataset.jsonl`), a list of **graders** and run defaults. You run it from the console, the CLI or MCP. Results are stored in the run store, so they survive restarts and can be compared later. Saving an eval never changes past runs: each run keeps a snapshot of exactly what it used.

## Concepts

| Term | Meaning |
|------|---------|
| **Eval** | The definition file `evals/<id>.eval.yaml`: target, dataset, graders, defaults |
| **Target** | What the eval tests: one stage (`kind: stage`) or one agent (`kind: agent`) |
| **Dataset** | A file of cases |
| **Case** | One test input with an `id`, an `input`, and optional `expected`, `tags`, `title`, `goal`, `metadata`. For an agent it is a **scenario** |
| **Repeat** | One execution of a case. Each case runs `repeats` times because models vary |
| **Result** | One (case, repeat): the stage output (or the agent conversation) plus its grades. 24 cases with 3 repeats make 72 results |
| **Grader** | One rule that scores a result: `schema`, `field`, `reference`, `rubric` or `code`; for agents also `tool_calls`, `conversation_check` or `goal_reached` |
| **Grade** | One grader's verdict on one result |
| **Rubric** | A grader written in words and judged by a model |
| **Judge** | The model that applies rubrics |
| **Eval run** | One execution of an eval: all results, grades, statistics, cost, and a config snapshot |
| **Stage run** | The normal Stageflow run started for each result. Marked `origin = eval` and hidden from the Runs list, Inbox and Overview |
| **Eval session** | For an agent target, the agent session opened for each conversation. Marked as an eval session and hidden the same way |
| **Config snapshot** | Everything that determined an eval run, stored with it and never edited |
| **Fingerprint** | The first 8 hex characters of a hash of the config snapshot. Equal fingerprints mean the same setup |
| **Engine** | The component that executes results and grades them. Today [promptfoo](https://github.com/promptfoo/promptfoo), installed on demand |

See also the [Glossary](glossary.md). Agent terms (scenario, driver, simulator, conversation subject, tool policy) are in [Agent concepts](#agent-concepts).

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

To try an agent instead, follow [Evals for agents](#evals-for-agents): the repository also ships a support-agent sample that runs with no judge model.

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

The target is one stage, in one of two forms (paths are relative to the eval file). To evaluate an agent instead, see [Evals for agents](#evals-for-agents).

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

## Evals for agents {#evals-for-agents}

An eval can also test an **agent** (see [Agents](agents.md)). Everything above still applies: the same file, dataset, graders, repeats, statistics, compare, CLI, MCP and console. What changes is the unit under test. A stage case is one input and one output. An agent case is a **conversation**: several user messages, several agent replies and any tool calls in between. Stageflow plays the user, records the whole conversation, and grades it.

Use it to check that an agent still answers from its instructions, asks a clarifying question when it should, declines what it should decline, calls the right tools and never calls the wrong ones, before you save a change to its instructions, model or tools.

### Agent concepts {#agent-concepts}

| Term | Meaning |
|------|---------|
| **Scenario** | An agent case: the `input` of a dataset row. It describes the user, either as a fixed list of messages or as a persona and a goal |
| **Driver** | What plays the user in a scenario: a **script** (fixed messages) or a **simulator** |
| **Simulator** | A model that plays the user from a persona, a goal and some facts. Set with `defaults.user_model` (default: the judge) |
| **Conversation subject** | What graders read: the messages, the recorded tool calls, the final reply, the number of turns, why it ended, and usage. It is the agent counterpart of a stage's envelope |
| **Tool policy** | What happens when the agent calls a tool during an eval: `read_only` (default), `mocked` or `real` |
| **Approval policy** | What happens when the agent calls a tool that would ask a person first: `record_only` (default), `deny` or `auto_approve_read` |
| **Eval session** | The agent session Stageflow opens for each conversation. It is a normal agent session marked as an eval session, and it is hidden from the places people look (see [Eval sessions](#eval-sessions)) |

Most terms from the [concepts table](#concepts) above carry over: a **result** is one repeat of one scenario, a **grade** is one grader's verdict on the conversation, and the run's **config snapshot** records the agent's revision and definition, the tool and approval policies and the simulator.

### Quick start with the sample

The repository ships [`examples/evals/support-sample.*`](../examples/evals/README.md#support-sample-eval-agent): a small support agent (`support_sample`) that answers from four facts in its instructions, six scripted scenarios and five graders. It uses `script` mode and no `rubric` or `goal_reached` grader, so it needs **no judge model**. It still calls the agent's own model for every turn, so a default model must be configured.

1. **Set a default model** in `stageflow.yaml` (`model: anthropic/claude-sonnet-4-5`, or any id you have a provider for).
2. **Install the sample into your project.** The agent resolves from the project's `agents/` directory, so the sample has to be installed there. Through a running Host, `POST /api/evals/sample` with `{ "kind": "agent" }` writes the agent through the agent service (so it gets a revision), enables it, and copies the eval and dataset into your `evals/` and `datasets/` roots with the dataset path rewritten. It fails with `SAMPLE_NO_DEFAULT_MODEL` (422) when the project has no default model and with `SAMPLE_EXISTS` (409) if the sample, or an agent with its id, is already there. By hand: copy the three files from `examples/evals/` (the agent as `agents/support_sample.agent.yaml`), fix the `dataset:` path, and optionally `sf agents enable support_sample`. Evals may run a disabled agent, which only warns (`eval.agent_disabled`).
3. **Validate, install the engine, run:**

   ```bash
   sf eval validate support-sample
   sf eval engine install
   sf eval run support-sample
   ```

   This calls your model for each turn: 6 scenarios x 2 repeats, one to two turns each. `max_cost_usd: 1` caps the spend. The command waits, prints the outcome and exits `0` only when the run passed.

To turn the sample into a simulated eval, add `persona`, `goal` and `opening` to the scenarios, set `conversation.mode: simulated`, a `defaults.user_model` and a `goal_reached` grader. The sample README shows the lines.

### Writing an agent eval

```yaml
version: 1
id: support-basics
name: Support agent basics
type: capability
target:
  kind: agent
  agent: support                      # agents/support.agent.yaml
dataset: ../datasets/support-scenarios.dataset.jsonl
defaults:
  repeats: 3
  pass_threshold: 0.8
  judge: anthropic/claude-sonnet-4-5
  user_model: anthropic/claude-sonnet-4-5
  max_cost_usd: 3
  concurrency: 2
conversation:
  mode: simulated
  max_turns: 8
  turn_timeout_ms: 120000
  tools: read_only
  approvals: record_only
  read_only_tools: [billing.lookup_invoice]
graders:
  - id: no-refund-without-approval
    type: tool_calls
    must_pass: true
    must_not_call: [billing.refund]
  - id: looks-up-the-invoice
    type: tool_calls
    must_call: [billing.lookup_invoice]
    max_calls: 3
  - id: one-question-at-a-time
    type: conversation_check
    max_agent_questions_per_turn: 1
  - id: reaches-the-goal
    type: goal_reached
    weight: 3
  - id: stays-polite
    type: rubric
    rubric: The agent stays polite and never blames the customer.
```

The key tables are in [YAML catalog: Agent evals](yaml-catalog.md#agent-evals). Points that differ from stage evals:

- **Target.** `target: { kind: agent, agent: <id> }`. There is no `revision` key: a run reads the agent's **current revision** once when it starts and records it. There is no `task` block. Archived agents are an error (`eval.agent_archived`).
- **Defaults.** `concurrency` defaults to 2 and `max_cost_usd` to 1, lower than for stages, because a conversation holds a model session for many turns and costs more. `model` replaces the agent's model for every scenario. `user_model` is the simulator.
- **`conversation`.** Mode, turn limit, timeouts and the two policies below. Omit it for script mode, 8 turns, `read_only`, `record_only`.
- **Limits.** The eval's limits replace the agent's own `limits` for eval sessions: `max_turns + 1` agent turns, a session time of `ceil(max_turns x turn_timeout_ms / 60000) + 5` minutes, no per-session cost limit (the eval's cost limit applies), always-on off. The snapshot records both the agent's values and the effective ones. A scenario also stops after `max_turns x turn_timeout_ms + 60 s` of wall clock. The agent file is never edited.
- **Side effects off.** Eval sessions never send on channels, run schedules, use web chat, push OTLP spans, or call the groundedness judge. Capture is forced to `full` so graders and the transcript see tool arguments and results.

#### Tool policy

`conversation.tools` decides what a tool call does. Every call is recorded in the conversation whatever happens to it, with its outcome.

| `tools` | Read-class tools | Every other tool |
|---------|------------------|------------------|
| `read_only` (default) | Run | **Stubbed**, or **mocked** if the scenario has a `tool_mocks` entry for it |
| `mocked` | Mocked if the scenario has a mock, else run | Mocked if the scenario has a mock, else stubbed |
| `real` | Run | Run |

Read-class means the built-in `read`, `grep`, `find` and `ls`, a Stageflow tool whose risk is `read`, and any tool you list in `conversation.read_only_tools`. Everything else, including `write`, `edit`, `bash`, destructive or external Stageflow tools, **MCP tools you have not listed** and browser tools, is treated as not read-only, because Stageflow cannot tell whether an MCP tool changes anything.

Outcomes you will see on a recorded tool call (`policy_outcome`):

- `ran`: the tool executed.
- `stubbed`: it did not execute; the agent was told "<tool> was not executed in this evaluation."
- `mocked`: it did not execute; the agent received the scenario's canned text. A mock reaches the agent as an error-flagged tool result, because the runtime can only block a call with a reason. Treat mocks as approximate.
- `would_ask_first` and `denied`: see below.

**Always blocked.** Under `read_only` and `mocked`, `stageflow.run_eval`, `stageflow.agent_chat`, `stageflow.fire_trigger`, `stageflow.probe_project_mcp` and every sub-agent call (`agent:<id>`) are blocked and recorded `denied`. Under `real`, `run_eval`, `agent_chat` and `fire_trigger` stay blocked (no recursion, no triggers). A tool the agent is not granted, a write to a protected path and the operator-only Stageflow tools are denied under every policy. Sub-agents the agent is allowed to call run in their own eval sessions under the same policy; their cost is summed into the result.

**`real` needs two consents.** `tools: real` requires `conversation.allow_real_tools: true` in the file (without it: `eval.real_tools_not_allowed`, an error) **and** consent for each run: `--allow-real-tools` on the CLI, `allow_real_tools: true` in the API and MCP start body, a checkbox in the console's run dialog. Without the run consent the start is refused (`EVAL_REAL_TOOLS_NOT_CONFIRMED`, HTTP 422, exit `1`). Validation always shows `eval.tools_real` as a warning. In `real` mode the agent's write, shell and MCP tools **act on your project and your services from this machine**. Use a throwaway copy of the project, or stay on `read_only`. A run can only make the policy safer than the file says (`tools` to `read_only` or `mocked`, `approvals` to `record_only` or `deny`); a riskier override is refused (`EVAL_INVALID`).

#### Approval policy

Some tools ask a person first: the tools in the agent's `approvals.ask_first`, and `bash` always (see [Agent runtime: asking first](agent-runtime.md#asking-first)). In an eval nobody is there to decide, so a person is **never asked**: no approval row is created, no turn waits, and nothing reaches the Inbox.

| `approvals` | An ask-first call that is read-class | An ask-first call that is not read-class |
|-------------|--------------------------------------|------------------------------------------|
| `record_only` (default) | `would_ask_first` | `would_ask_first` |
| `deny` | `denied` | `denied` |
| `auto_approve_read` | Goes on to the tool policy (can run) | `would_ask_first` |

In every case the agent is told "Approval for <tool> was not granted in this evaluation. Continue without it." `would_ask_first` is what a `tool_calls` grader can assert with `must_ask_first`: "the agent tried something that needs approval". Use it to check that an agent asks before refunding rather than refunding.

### Scenarios and datasets

A dataset row for an agent eval is a **scenario**. Dataset files are the same as for stages; only `input` is read differently. There are two modes, set by `conversation.mode` and overridable per scenario with `input.mode`.

```jsonl
{"id":"s002","title":"Order status, scripted","input":{"mode":"script","script":["Where is my order 1042?","It was ordered on Monday.","Thanks"]},"expected":{"tools":["orders.get_status"]}}
{"id":"s001","title":"Refund request, angry customer","input":{"mode":"simulated","persona":"Annoyed Pro customer, short sentences.","goal":"Get a refund for a double charge on invoice INV-2093.","opening":"I was charged twice and I want my money back.","facts":["invoice INV-2093","charged on the 3rd"],"tool_mocks":{"billing.lookup_invoice":{"result":{"status":"duplicate"}}}},"expected":{"outcome":"escalated_to_human","tools":["billing.lookup_invoice"],"forbidden_tools":["billing.refund"]},"tags":["billing"]}
```

- **`script`.** `input.script` is the list of user messages (1 to 40). They are sent in order. The conversation ends after the last one is answered (`stop_reason: script_end`) or at `max_turns`. It is deterministic, cheap, and best for regressions.
- **`simulated`.** `input.opening` is sent as the first user message as written. After each agent reply the simulator model writes the next user message from `persona`, `goal` and `facts` (things the user knows and reveals only when asked or natural), and ends the conversation when the goal is met, the user gives up, it repeats itself, or `max_turns` is reached. It adds a model call per turn and some noise.
- **`tool_mocks`** maps tool ids to `{ "result": … }` or `{ "error": "…" }`. They apply under `read_only` (for tools that would be stubbed) and `mocked`, and are ignored under `real`.
- **`expected`** is free JSON. Three keys have a meaning: `outcome` (text, the fallback goal for `goal_reached`), `tools` (the default `must_call` of a `tool_calls` grader) and `forbidden_tools` (the default `must_not_call`).

Field limits are in [YAML catalog: datasets](yaml-catalog.md#datasets-dataset-jsonl). A scenario that fails its mode's check is **skipped** when a run starts and reported (`dataset.input_mismatch`, "scenario …"); typos inside `input` warn (`dataset.scenario_unknown_field`). In the console you can add scenarios in a form, upload a file, or build script scenarios from finished sessions of the agent (**From past sessions**: each selected session becomes a script of its user messages, with `expected.tools` set to the tools it called and the tag `from-session`; tool results are not copied). An upload maps columns to `input.opening`, `input.goal`, `input.persona`, `input.mode`, `input.facts` (split), `expected.outcome`, `expected.tools`, `expected.forbidden_tools`, `title` and `tags`. **Scripts and tool mocks cannot be mapped from CSV**; they need a JSON or JSONL file (a hand-written CSV can use `input.script:json`). A dataset can serve a stage eval and an agent eval at once, but most rows will be invalid for one of them, so the console warns.

### Graders for conversations

A grader reads the **conversation subject**, not the envelope. A grader type that cannot apply to the target is an error at validation (`eval.grader_not_applicable`).

| Type | Stage | Agent |
|------|-------|-------|
| `schema` | yes | no |
| `field`, `reference`, `code`, `rubric` | yes | yes |
| `tool_calls`, `conversation_check`, `goal_reached` | no | yes |

**`tool_calls`.** Passes when every rule holds; score 1 or 0.

```yaml
- id: no-refund-without-approval
  type: tool_calls
  must_pass: true
  must_not_call: [billing.refund]      # none of these may be called
- id: looks-up-the-invoice
  type: tool_calls
  must_call: [billing.lookup_invoice]  # each must be called at least once
  max_calls: 3                         # at most this many calls in all
  args:
    - { tool: billing.lookup_invoice, path: invoice_id, op: matches, value: "^INV-[0-9]+$" }
- id: asks-before-refunding
  type: tool_calls
  must_ask_first: [billing.refund]     # must appear as would_ask_first
```

A call counts as called whatever its outcome, so an attempted `billing.refund` that was stubbed still breaks `must_not_call`. `args` checks the arguments of **every** call to that tool (`path` into the arguments, `op` as for `field`); a tool never called passes it vacuously, so pair it with `must_call`. A trailing `.*` matches a server prefix. When `must_call` or `must_not_call` is absent, the case's `expected.tools` and `expected.forbidden_tools` are used; write `[]` to opt out. With no rule at all for a case the grade is an error (`EVAL_CASE_MISSING_EXPECTED`) and the case is left out of that grader's statistics.

**`conversation_check`.** Deterministic checks of the shape of the conversation: `max_turns` (user turns), `max_agent_questions_per_turn` (a question is a `?` followed by a space or the end of the text, outside code fences and URLs) and `final_reply` (a list of `field` checks applied to the last assistant message).

**`goal_reached`.** A judge reads the conversation and decides whether the agent achieved the scenario's goal (`input.goal`, else `expected.outcome`). It does not trust the simulator's own "done" signal. Pass or fail only. Optional `judge` and `guidance`. Needs a judge model.

**Existing graders on a conversation.** `field` and `reference` paths start at the conversation, with no prefix: `final_reply`, `turns`, `stop_reason`, `messages[*].text`, `tool_calls[*].name`, `tool_calls[0].args.invoice_id`, `usage.cost_usd`. `reference` defaults to `path: final_reply`. `code` receives the conversation as `output`. `rubric` has the judge read a **bounded transcript**: at most 30 turns, 2,000 characters per message, 500 for tool arguments and 500 for tool results, with a rubric prompt written for conversations. The conversation graders see text that is already redacted and capped (below).

**The conversation subject.** Stored with each result and shown as the transcript:

| Field | Meaning |
|-------|---------|
| `messages[]` | `{ role, text, turn }`, user and assistant, up to 80 messages (the first 4 and last 76 are kept) of up to 4,000 characters |
| `tool_calls[]` | `{ name, turn, args, result_summary, status, policy_outcome }` in call order, up to 200 |
| `final_reply`, `turns` | The last assistant message; user turns completed |
| `stop_reason` | `script_end`, `resolved`, `abandoned` (the simulated user gave up), `max_turns`, `no_progress` (the user repeated itself), `empty_message`; `error` or `timeout` on a failed result |
| `usage` | Cost and tokens, split into agent (sub-agents included) and simulator, and the call counts |

All text is redacted for secrets before it is capped and stored.

### Running an agent eval

Run it from the console, `sf eval run <id>`, or `run_eval`, as for a stage ([Running an eval](#running-an-eval)). Differences:

- **What is called.** Each conversation calls the agent's model (and its sub-agents'), the simulator model for each simulated turn after the opening, and the judge for `rubric` and `goal_reached` graders. Run overrides: `--model` (the agent's model), `--user-model`, `--judge`, plus the safer-only `tools` and `approvals` and the `real` consent described above.
- **The revision is pinned at start.** The run reads the agent once, runs that definition (with your model override) for every scenario, and records its revision and definition hash. Editing the agent while a run is in progress does not change that run. Afterwards the Config tab marks the run "edited since" when the agent's current revision differs, and Compare shows what changed in the agent. The run dialog has no revision picker: it always uses the current revision.
- **Failures.** A conversation whose agent turn fails (backend error, guardrail block, model timeout, limit reached) is recorded with the partial transcript as `stage_failed` and `EVAL_AGENT_FAILED`; one that exceeds `turn_timeout_ms` or the wall clock is `EVAL_AGENT_TIMEOUT`; a simulator failure is `error` with `EVAL_SIMULATOR_ERROR`. Failed results count as failed, not as missing, and are not graded. A turn can never wait for an approval.
- **Try on one case.** The console can run one scenario once (`POST /api/evals/try`) and show the transcript and grades without storing a run. It can take minutes, it honors the real-tools consent, and it is refused while an eval run is active.

#### Cost and limits

An estimate shown before a run counts agent turns, simulator calls and judge calls. With a previous completed run it uses that run's actual mean cost; without one it uses fixed assumptions (up to 6 user turns for simulated scenarios, the script length for scripted ones, two tool calls per turn, typical token counts) and says so, and a missing model price makes it unknown. Cost counts the agent, its sub-agents, the simulator and the judge; where a provider reports no simulator usage, the simulator's cost is estimated from text length and flagged. A multi-turn case can cost 4 to 10 times a stage case. **The cost limit is checked before a conversation starts, not inside it**, so a run can pass `max_cost_usd` by up to `concurrency` conversations. Results not started when the limit is reached are skipped and the run ends `budget_stopped`. Budgets (`budget.latency_ms`, `budget.cost_usd`) apply per conversation.

Agent turns share the Host's model capacity with real agent use, and one eval run is active per Host, so keep `concurrency` at 2 unless you know the provider can take more.

### Reading results

The result pages are the same, with agent additions: **Turns** and **Tool calls** tiles (the mean per conversation), the cost split into agent, simulator and judge, and a **Transcript** tab in the case drawer. The transcript lists each turn's messages, with tool call chips showing the outcome (Ran, Stubbed, Mocked, Would ask first, Denied), the arguments and the result summary, the stop reason, and a link to the agent run (with its waterfall) while the session still exists. A failed result shows the partial transcript and the error. Compare shows the agent's changed definition keys and an instructions line diff instead of a stage diff, and informational deltas for mean turns and tool calls. Comparing a stage run with an agent run, or runs of different agents, is refused (`EVAL_COMPARE_MISMATCH`).

**Honest statistics for conversations.** The formulas are unchanged, but their meaning shifts:

- **pass^k is stricter.** A conversation has many places to go wrong, so a scenario that passes one repeat in two is common. Reliability (pass on every repeat) will usually sit well below the pass rate. Read it before trusting a number.
- **Repeats matter more.** Use at least 3 and look at flaky scenarios; one run of a conversation is closer to one coin flip than one run of a stage.
- **Simulated users add noise.** Both the agent and the simulator vary, so two repeats of one scenario can be different conversations. Script mode removes the second source. When you compare two runs, keep the simulator model, its prompt version and the scenarios the same (Compare lists these when they differ); a changed simulator makes two runs not comparable.
- **Deterministic graders are cheap, judged ones are not.** Prefer `tool_calls` and `conversation_check` for what you can state as a rule, and use `goal_reached` and `rubric` for what you cannot.
- The conversation graders (`tool_calls`, `conversation_check`) are rules you wrote; the judged ones are **not calibrated** against your labels, as for stages.

### Eval sessions {#eval-sessions}

Each conversation runs in an **eval session**: a real agent session marked `source: "eval"`, pinned to the revision the run recorded. Eval sessions are **hidden** from the agent's session list, the Inbox, pending approvals, counts, and any retention-visible view, so evals never show up as real work. They stay readable **by id**: the result's transcript links to the agent run page, which shows the usual spans, tokens and cost, and a banner naming the eval and run. Deleting an eval run deletes its eval sessions and their sub-agent sessions; the stored conversation on the result remains readable if a session is already gone. Sessions an eval run left behind (a crash) are cleaned up when the Host next starts, once they are older than 7 days and no result references them. See [Agents](agents.md) and [Agent observability](agent-observability.md#eval-sessions).

### Troubleshooting agent evals

| Symptom | Cause and fix |
|---------|---------------|
| `eval.agent_not_found` | The agent file is not in the project's `agents/` directory (`sf eval validate` reads the file; a Host reads the agent catalog). For the sample, install it (see above) |
| `eval.agent_archived` | The agent is archived. Restore it or point the eval at another agent |
| `eval.agent_disabled` (warning) | The agent is disabled. Evals run it anyway; enable it only if you also want to chat with it |
| `eval.agent_invalid` | The agent file has problems (the finding names the first). Fix it in the agent editor |
| `SAMPLE_NO_DEFAULT_MODEL` | The agent sample needs a default `model:` in `stageflow.yaml` |
| `eval.simulator_unsupported` / `eval.user_model_missing` | A `simulated` scenario needs a simulator, and only `anthropic/…`, `openai/…` and `openrouter/…` models can play it. Set `defaults.user_model` (or a judge) to one of those |
| `eval.grader_not_applicable` | A `schema` grader on an agent, or `tool_calls`, `conversation_check`, `goal_reached` on a stage |
| A tool shows **Stubbed** and the agent says it "was not executed" | Expected under `read_only`: the tool is not read-only (or an MCP tool you did not list). List it in `conversation.read_only_tools` if it is safe, give the scenario a `tool_mocks` entry, or accept the stub. Under `read_only` a stubbed write still counts as a call for `must_not_call` |
| A tool shows **Would ask first** | The tool is in the agent's `ask_first` list (or is `bash`). Under `record_only` the call is recorded and denied, never run. Assert it with `must_ask_first`, or use `auto_approve_read` for read-class tools |
| `eval.real_tools_not_allowed` / `EVAL_REAL_TOOLS_NOT_CONFIRMED` | `tools: real` needs `allow_real_tools: true` in the file and the per-run consent (`--allow-real-tools`, the API or MCP flag, or the dialog checkbox) |
| The run shows "edited since" on the agent | The agent changed after the run started. The run used the revision it recorded; run again to test the new one |
| Results `EVAL_AGENT_TIMEOUT` | A turn ran past `turn_timeout_ms`, or the scenario past its wall clock. Raise `turn_timeout_ms` or simplify the scenario |
| Results `EVAL_AGENT_FAILED` | An agent turn failed; the message carries the agent error code (for example `agent.guardrail_blocked` or `agent.limit_reached`). Open the agent run from the partial transcript |
| Results `EVAL_SIMULATOR_ERROR` | The simulator model failed or returned nothing usable. Check its key and model, or switch to script mode |
| A scenario was skipped | Its `input` fails the mode's check. The dataset page lists the reason |
| Every `tool_calls` grade is `EVAL_CASE_MISSING_EXPECTED` | The grader has no rule and the scenarios have no `expected.tools` or `expected.forbidden_tools`. Add rules to the grader or `expected` to the scenarios |

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

Rubric graders and `goal_reached` need a judge model, and `simulated` scenarios need a simulator model (`defaults.user_model`, which falls back to the judge) from the same providers. In this release only **`anthropic/…`**, **`openai/…` and `openrouter/…`** model ids can be judges. Any other provider is refused when the run starts (`EVAL_INVALID`, "supported judge providers are …"). The stage itself can use any provider.

The judge's key comes from a Pi `auth.json` entry of type `api_key` for that provider (the credential file the Host already uses; see [Providers](providers.md)), or else the environment variable of the same name: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. OAuth credentials (for example subscription tokens) are not API keys and cannot be used for judging. The key goes to the engine process through its environment and is never written into a config file or a result.

## Privacy and trust

- Running an eval sends **each case's input to the stage's model** as a normal stage run.
- For **rubric graders**, each case's input and the stage output are also sent to **the judge model's provider**.
- **Nothing is sent to promptfoo's services.** Telemetry and remote features are blocked.
- **`code` graders run JavaScript on your machine with your permissions**, the same trust level as `verify: command`.
- Results, outputs and your reviews are stored in the local run store ([Data directory](data-directory.md)). Stage runs started by evals are retained and purged like other runs.

For **agent evals**, in addition:

- A **simulator model** and the **judge** read the conversation (the scenario, the agent's replies and a bounded view of tool arguments and results), so they send it to their providers.
- Each scenario's messages go to the **agent's model** as a normal agent turn.
- **Tool calls in `real` mode act on the project** and on any service the agent's tools reach, from this machine. By default (`read_only`) write, shell and unlisted tools are **stubbed and recorded**, not executed.
- **Nothing is sent to promptfoo's services.**
- Transcripts store **redacted text only**: secrets are redacted before text is capped and stored.
- Eval sessions are **hidden** from agent lists, the Inbox, counts and retention-visible views, but remain readable by id.

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

Agent evals have their own table in [Troubleshooting agent evals](#troubleshooting-agent-evals). Validation findings are listed in [YAML catalog: Evals](yaml-catalog.md#eval-validation-findings).

## HTTP API

The console uses these routes (all under the Host's `/api`, with the same auth as other routes). Eval runs are addressed by `eval_run_id` (`er_` plus 12 hex characters) or by eval id and run number.

| Route | Purpose |
|-------|---------|
| `GET /api/eval-engine` | Engine status |
| `GET /api/evals`, `POST /api/evals` | List (with status, banner, footer); create |
| `GET /api/evals/:id`, `PUT /api/evals/:id` | One eval with findings; save |
| `POST /api/evals/validate`, `POST /api/evals/try`, `POST /api/evals/sample` | Validate a draft; run one case; install the sample (body `kind` is `stage` or `agent`, default stage) |
| `GET /api/evals/agent-targets` | Agents that can be an eval target, with model, revision, tools and why one is unavailable |
| `POST /api/evals/:id/runs`, `GET /api/evals/:id/runs/:n`, `GET /api/evals/:id/runs/estimate` | Start a run; read by number; estimate |
| `GET /api/evals/:id/failure-types` | Failure-type vocabulary |
| `GET /api/eval-runs`, `GET /api/eval-runs/:id`, `DELETE /api/eval-runs/:id` | List, read, delete runs (`?subject_ref=<session or stage run id>` finds the run that owns a session) |
| `GET /api/eval-runs/:id/results`, `…/results/:caseId`, `PUT …/results/:caseId/:repeat/review` | Result rows, one case, a review |
| `POST /api/eval-runs/:id/cancel`, `GET /api/eval-runs/:id/export` | Cancel; export |
| `GET /api/eval-compare?a=&b=` | Compare two runs |
| `GET /api/datasets`, `POST /api/datasets`, `GET /api/datasets/:id`, `PATCH /api/datasets/:id/cases`, `POST /api/datasets/:id/convert`, `POST /api/datasets/preview`, `GET /api/datasets/candidates` | Datasets (`GET /api/datasets/:id?eval_id=` checks scenarios against an agent eval; `candidates?agent=<id>` lists finished sessions to turn into scenarios) |

For agent targets, `POST /api/evals/:id/runs` also takes `user_model`, `allow_real_tools`, and the safer-only `tools` and `approvals`; the estimate route takes the same options; a run that needs real tools without consent answers `422 EVAL_REAL_TOOLS_NOT_CONFIRMED`. Result detail carries the stored conversation (`output`), `turns`, `tool_call_count` and `agent: { id, session_id }`; run stats carry `mean_turns` and `mean_tool_calls`.

## Not built {#not-built}

These are not part of this release:

- **`command` graders** (graders that run a command in a workspace).
- **Judge calibration.** Rubrics are shown as "Not calibrated": nothing checks the judge against your labels, and reviews are not used for that.
- **Pipeline evals** (evaluating a whole pipeline end to end).
- **CI triggers or scheduled eval runs.** `sf eval run` works in CI, but nothing starts evals on a schedule.
- **Editing an eval in the console.** The Edit page is not built yet; edit the YAML file directly.
- Synthetic data generation, production monitoring, red-teaming and deleting an eval from the console.

Not built for **agent evals**:

- **Voice and channel-specific evals.** Conversations run in memory; no channel, schedule or web chat is involved.
- **Red-teaming and adversarial scenario generators**, and **auto-generated scenarios**. You write or import scenarios.
- **Production or online evals.** Evals run on scenarios, not on live traffic.
- **Multi-agent topologies as a target.** One agent is the target; its sub-agents run inside it.
- **Human labelling and judge calibration** for conversations, as for stages.
- **Scheduled or CI triggers.** `sf eval run` and its exit codes work in CI, but nothing starts runs for you.
- **A `groundedness` grader**, and a revision picker in the run dialog (a run uses the agent's current revision).
- **A shipped simulated sample.** The sample is script mode; the README shows how to make it simulated.
- **Editing the agent from the eval screens**, beyond what evals already do for their own files.

## See also

- [Console: Evals](console-evals.md)
- [YAML catalog: Evals](yaml-catalog.md#evals-eval-yaml)
- [CLI reference: `sf eval`](cli-reference.md#sf-eval)
- [MCP: eval tools](mcp.md#eval-tools)
- [CI: evals](ci.md#evals-in-ci)
- [Sample project](../examples/evals/README.md) (a stage sample and an agent sample)
- [Agents](agents.md) and [Agent definition](agent-definition.md)
