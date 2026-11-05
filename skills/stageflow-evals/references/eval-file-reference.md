# Eval file reference

The key tables for `evals/<id>.eval.yaml`, how paths and ids resolve, and how to write the file safely. Unknown keys at any level are an error (`eval.unknown_key`), so typos surface at validation.

## Contents

- Where the files live
- A complete stage eval
- Top-level keys
- Target
- Defaults
- Conversation block (agents)
- Task and budget
- Run-time overrides
- Writing the file: files first, MCP when there is no file access
- Samples

## Where the files live

| File | Default location | Pattern |
|---|---|---|
| Eval | `evals/` | `<id>.eval.yaml` |
| Dataset | `datasets/` | `<name>.dataset.jsonl` (also `.dataset.json`, `.dataset.csv`) |
| Agent target | `agents/` | `<agent_id>.agent.yaml` |
| Stage target | the pipeline or stage file named in `target` | |

The manifest `stageflow.yaml` may list other roots under `catalog.evals` and `catalog.datasets` (each defaults to `evals` and `datasets`). A project with no manifest still uses those two defaults. An eval file outside a listed root is not found by `sf eval validate <id>`.

All paths inside an eval file resolve against the directory of the eval file, and the dataset must stay inside the project root. An eval in `evals/` reaches a dataset with `../datasets/x.dataset.jsonl`.

## A complete stage eval

```yaml
version: 1
id: ticket-triage
name: Ticket triage
description: Does the classify stage pick the right category, flag urgent messages and summarize faithfully?
type: capability
target:
  kind: stage
  pipeline: ../pipelines/ticket-triage.pipeline.yaml
  stage: classify
dataset: ../datasets/ticket-triage.dataset.jsonl
defaults:
  repeats: 3
  judge: anthropic/claude-sonnet-4-5
  judge_settings:
    temperature: 0
  pass_threshold: 0.8
  max_cost_usd: 2
  concurrency: 4
graders:
  - id: output-schema
    type: schema
    must_pass: true
  - id: category-matches
    type: reference
    weight: 3
    mode: equals
    path: payload.category
    expected: expected.category
  - id: urgent-flagged
    type: code
    weight: 2
    code: |
      return !testCase.tags.includes("urgent") || output.payload.urgency === "high";
  - id: summary-is-faithful
    type: rubric
    rubric: |
      Pass if the summary is one sentence and every fact in it appears in the message.
      Fail if the summary adds a detail, a cause or a promise that the message does not contain.
    scale: pass_fail
budget:
  latency_ms: 120000
  cost_usd: 0.1
```

The runnable copy, with its pipeline and dataset, is `assets/examples/stage-eval/`. A complete agent eval is `assets/examples/agent-eval/`.

## Top-level keys

| Key | Required | Rule |
|---|---|---|
| `version` | yes | Only `1`. |
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,62}$` (lowercase, digits, hyphens). Must equal the filename stem (`eval.id_filename_mismatch`). Unique in the project. No underscores or capitals, unlike agent ids. |
| `name` | no | 1 to 80 characters. Defaults to the id. |
| `description` | no | Up to 500 characters. Write the question the eval answers. |
| `type` | no | `capability` (default) or `regression`. Label only; changes no behavior. |
| `target` | yes | A stage or an agent. |
| `dataset` | yes | Path to the dataset file, relative to the eval file. |
| `task` | no | `{ goal?, context?, constraints? }`, all strings. Stage targets only (`eval.task_not_applicable` on an agent). |
| `defaults` | no | See Defaults. |
| `conversation` | no | Agent targets only (`eval.conversation_not_applicable` on a stage). |
| `graders` | yes | 1 to 20 graders with unique ids (`eval.grader_duplicate_id`). |
| `budget` | no | `{ latency_ms?, cost_usd? }`. Positive numbers. Per-result warnings, never failures. |

Stageflow writes keys in this order: `version, id, name, description, type, target, dataset, task, defaults, conversation, graders, budget`. Keep it when you write by hand so diffs stay small.

## Target

```yaml
target: { kind: stage, pipeline: ../pipelines/ship.pipeline.yaml, stage: review }
target: { kind: stage, file: ../stages/review.yaml }
target: { kind: agent, agent: handbook_helper }
```

- `kind: stage` takes exactly one form: `pipeline` plus `stage`, or `file`. Anything else is `eval.target_invalid`.
- The stage must load. With no resolvable model, `eval.target_unresolved` says the pipeline does not load: set a default `model:` in `stageflow.yaml` or on the stage.
- A pipeline stage is rebuilt from its own YAML with the pipeline's model default. Pipeline-level overlays (entry `mcp`, `secrets`, `requires`, wrapper `completion`, pipeline `channels` and `schemas`, `include` merges) are not applied, so the stage can behave differently under eval than inside its pipeline.
- Cases run with no repository checkout. A stage that needs one cannot be evaluated yet (`eval.stage_needs_checkout`). A stage that stops at a HITL gate records an error for that case (`eval.stage_has_gates`).
- `kind: agent` takes only `agent: <id>`. No `revision`, `pipeline`, `stage` or `file` (`eval.target_invalid`). A run reads the agent's current revision once at start and records it. Archived agents are an error; disabled agents only warn.
- `kind: internal_agent` targets the console's built-in agents and is hidden unless the Host sets `STAGEFLOW_SHOW_INTERNAL_AGENTS=1`. Leave it alone unless the user asks.

## Defaults

| Key | Default | Rule |
|---|---|---|
| `repeats` | 3 | 1 to 10. Executions per case. |
| `pass_threshold` | 0.8 | `0 < x <= 1`. A result passes at this score; the run passes at this pass rate. |
| `max_cost_usd` | 2 (agents: 1) | `> 0`. Covers stage or agent calls plus simulator and judge calls. |
| `concurrency` | 4 (agents: 2) | 1 to 8. Keep agents at 2 unless the provider can take more. |
| `judge` | none | `provider/model`. Needed by every `rubric` and `goal_reached` grader without its own `judge`. Only `anthropic/`, `openai/` and `openrouter/` ids can judge. |
| `judge_settings` | none | `temperature` (0 to 1), `reasoning` (boolean), `votes` (1, 3 or 5). A grader's own `judge_settings` wins key by key. |
| `model` | none | Replaces the stage's model, or the agent's, for every case. |
| `user_model` | the judge | Agents only. Plays the user in `simulated` scenarios. Same provider limit as the judge. |

Judge settings in practice:

- `votes: 3` or `5` makes the judge decide several times per grade and the majority wins (a tie fails; `1_to_5` uses the mean). Every vote is a paid call, and the cost estimate counts all of them.
- `votes` above 1 at `temperature: 0` warns (`eval.judge_votes_no_variation`) because every vote is the same call. Raise the temperature or use one vote.
- `reasoning: true` asks the judge to write its reason before the verdict.
- A judge equal to the stage's or agent's own model warns (`eval.judge_same_as_stage`, self-preference bias). A judge id ending in `latest` warns (`eval.judge_unpinned`); pin a dated version.
- Settings and the judge are part of the run fingerprint, so changing them makes runs not directly comparable.

## Conversation block (agents)

Omit it for script mode, 8 turns, `read_only`, `record_only`.

| Key | Default | Rule |
|---|---|---|
| `mode` | `script` | `script` or `simulated`. A scenario's `input.mode` overrides it per case. |
| `max_turns` | 8 | 1 to 30 user turns per scenario. Reaching it ends the case normally. |
| `turn_timeout_ms` | 120000 | 5000 to 600000. One user turn. |
| `tools` | `read_only` | `read_only`, `mocked` or `real`. See `agent-evals.md`. |
| `approvals` | `record_only` | `record_only`, `deny` or `auto_approve_read`. |
| `read_only_tools` | `[]` | Up to 50 MCP tool ids (`server.tool` or `server.*`) you declare read-only. Built-in and Stageflow tools cannot be declared read-only (`eval.read_only_tools_not_mcp`). |
| `allow_real_tools` | `false` | Consent to `tools: real`. Only valid with `tools: real`. Never set it yourself. |

The eval's limits replace the agent's own `limits` for eval sessions; the agent file is never edited.

## Task and budget

`task` is the template for each stage case's task: `goal` comes from the case's `goal`, else `task.goal`, else "Evaluate case <id>". `context` and `constraints` come from `task`; the case `input` is the task input. Use it when the stage reads the task goal; skip it when the stage only reads its input.

`budget.latency_ms` and `budget.cost_usd` flag a slow or expensive result with a warning shown on the result. They never fail it.

## Run-time overrides

A run can override `repeats`, `judge`, `model`, `max_cost_usd` and the case selection (`case_ids`, `tags`, `only_failed_from`) without editing the file. Agent runs also override `user_model` and may make `tools` or `approvals` safer, never riskier (`real` to `read_only` or `mocked`; `auto_approve_read` to `record_only` or `deny`). A riskier override is refused (`EVAL_INVALID`). Overrides are recorded in the run's snapshot. The CLI exposes `--repeats`, `--judge`, `--model`, `--user-model`, `--max-cost`, `--case`, `--tag`, `--label` and `--allow-real-tools`. `tools`, `approvals` and `only_failed_from` are MCP and HTTP only.

## Writing the file: files first, MCP when there is no file access

If you can write files in the project, write `evals/<id>.eval.yaml` and the dataset directly, then run `sf eval validate`. This is the simplest path and the validator catches everything the write tools would.

Use the MCP write tools only when you have no file access (a remote Host, a harness without a shell or editor). They write atomically and refuse stale edits:

| Tool | Use |
|---|---|
| `create_eval` | Pass `definition` (an object shaped like the file). Validates the whole plan first and writes only when it passes. `EVAL_EXISTS` if the id is taken. |
| `update_eval` | Pass exactly one of `definition` (merged into the current file) or `yaml` (full text), plus `base_hash` from `get_eval` (`file_hash`). |
| `create_dataset` | New file from `name` plus `cases`, or `source` `sample`, `runs` or `sessions`. To change an existing file pass `dataset_id`, `mode` (`append` or `replace`) and `base_hash`. |
| `update_dataset_cases` | `ops` of `add`, `update`, `delete`, `set_tags` in one all-or-nothing write, plus `base_hash`. |
| `convert_dataset` | Copy a `.dataset.json` or `.dataset.csv` to an editable `.dataset.jsonl`. |
| `install_eval_sample` | Install the packaged stage sample or the agent sample (see below). |

Write-path rules:

- `base_hash` for an eval is the SHA-256 hex digest of the file's bytes; `get_eval` returns it as `file_hash`. For a dataset it is a hash of the parsed cases that `sf eval datasets --json` and the dataset tools return as `hash`; do not compute it yourself. A stale hash fails `FILE_CHANGED` with the `current_hash`: re-read the file, reapply your edit, retry. Never retry with the new hash blindly.
- Only `.dataset.jsonl` is editable through the tools. `.json` and `.csv` fail `DATASET_READ_ONLY`; convert first.
- `EVAL_INVALID` carries `findings`. Fix them as you would validation findings; nothing was written.
- A hand-written dataset needs an `id` on every case. Tools assign `c001`, `c002`, ... to cases without one, never renumbering existing ids.

## Samples

`install_eval_sample` (MCP, or `POST /api/evals/sample` with `{ "kind": "stage" | "agent" }`, or **Try the sample eval** in the console) copies a ready eval into the project:

- `kind: stage` writes a `critique` pipeline, an 8-case dataset and an eval with four judge-free graders. It needs a default `model:` in `stageflow.yaml`.
- `kind: agent` writes a `support_sample` agent through the agent service, enables it and copies a script-mode eval with 6 scenarios and five judge-free graders. It fails `SAMPLE_NO_DEFAULT_MODEL` without a default model and `SAMPLE_EXISTS` if it is already installed.

Both are good for a first dry run of the whole lifecycle, and both still call the project's model when run, so confirm the cost first.
