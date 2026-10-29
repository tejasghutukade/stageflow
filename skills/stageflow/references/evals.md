# Evals

An eval runs one stage, or one agent, over a dataset of cases, grades every output, repeats each case, and reports a pass rate with honest error bars. Use it when the human asks whether a stage or an agent is any good, or whether a change to it made it better or worse. It works for any kind of stage or agent, not only code. For an agent a case is a whole conversation (see Agent evals below). This file is the one place the suite describes evals; job skills cite it.

Full docs: Stageflow docs: Evals (checkout: [docs/evals.md](../../../docs/evals.md); agents: [Evals for agents](../../../docs/evals.md#evals-for-agents)), [CLI reference: `sf eval`](../../../docs/cli-reference.md#sf-eval), [MCP: eval tools](../../../docs/mcp.md#eval-tools), [CI: evals](../../../docs/ci.md#evals-in-ci).

## Files

An eval is `evals/<id>.eval.yaml` (target stage or agent, dataset, graders, defaults). Its dataset is `datasets/<name>.dataset.jsonl` (one case per line: `id`, `input`, optional `expected`, `tags`). Samples: `examples/evals/` in the Stageflow repo (a stage sample and an agent sample). YAML keys and validation codes: [docs/yaml-catalog.md](../../../docs/yaml-catalog.md#evals-eval-yaml). Write these with the native Write tool like any catalog file; the cases must match the stage's `io.input.schema`.

## Free and paid

| Action | CLI | MCP | Cost |
|---|---|---|---|
| Check an eval and its dataset | `sf eval validate [<id\|path>] [--strict] [--json]` | `validate_eval` | Free, no model call |
| List, show, read runs and results, compare | `sf eval list`, `show`, `runs`, `runs show`, `compare`, `datasets` (all take `--json`) | `list_evals`, `get_eval`, `list_eval_runs`, `get_eval_run`, `get_eval_results`, `get_eval_result`, `compare_eval_runs` | Free |
| Check the engine | `sf eval engine status --json` | none | Free |
| Install the engine | `sf eval engine install` | none (CLI only) | Free, but downloads about 1.2 GB; needs Node 22.22.0 or newer |
| **Run an eval** | `sf eval run <id\|path> --json` | `run_eval` | **Calls models and costs real money** |
| Read failure suggestions | `sf eval suggestions <evalRunId> [--status ...] --json` | `get_eval_failure_suggestions`, `get_eval_failure_sort_status` | Free |
| **Sort failures** | `sf eval sort <evalRunId> [--classifier auto\|jev\|judge] [--limit n] [--resort] --json` | `sort_eval_failures` | **Sends failed results to TypeSafe Jev or the judge model; small cost.** Manual only; tags nothing |
| **Check a judge against the author's labels** | `sf eval calibrate <evalId> <graderId> [--split dev\|held_out] [--stability] --json` | `calibrate_eval_grader`, `list_grader_calibrations` (read-only) | **Re-judges the author's labeled outputs with the judge model (one call per label); costs money.** Never label results yourself: labels are the author's ground truth |
| Stop a run | `sf eval runs cancel <evalRunId>` | `cancel_eval_run` | Stops spending |

Never start an eval run on your own. Tell the human what it will do (cases x repeats stage calls, plus judge calls for rubric graders; for an agent, conversations of several turns, plus a simulator model for simulated scenarios and a judge for `rubric` and `goal_reached`) and the cost cap (`defaults.max_cost_usd`, default 2; `--max-cost` overrides it), and wait for a yes. Only one eval run is active per Host.

## Before a run

1. `sf eval validate <id> --strict --json` must pass. Fix findings first. A stage with no model needs a default `model:` in `stageflow.yaml` (`eval.target_unresolved` otherwise).
2. `sf eval engine status --json`: `installed` and `node_ok` must be true. If not, name the command and ask before installing.
3. Rubric graders need a judge from `anthropic`, `openai` or `openrouter` and an API key for it. Other providers cannot judge. A judge equal to the stage's model warns.
4. Pick MCP or CLI by [control-surface.md](control-surface.md). `run_eval` starts in the background by default; poll `get_eval_run`.

## Reading the result

`sf eval run --json` prints one document and exits `0` only when the run passed.

| `outcome` | Exit | Meaning |
|---|---|---|
| `passed` | `0` | Completed and the pass rate reached the threshold |
| `below_threshold` | `1` | Completed, pass rate under the threshold. Read the failing cases |
| `failed` | `1` | Could not finish (engine, invalid eval, Host error) |
| `cancelled` | `1` | Stopped by the user; completed results are kept |
| `budget_stopped` | `1` | Hit the cost cap; results are partial |

Report `pass_rate` with `pass_rate_ci` (a 95% interval computed over cases, so it is wide with few cases), the `threshold`, `results.errored`, `reliability` (share of cases that pass on every repeat; `null` with one repeat), `cost_total` and the `url`. Do not call a small difference real: for a before-and-after, use `sf eval compare <a> <b> --json` and report its `verdict` (`improved`, `regressed`, `no_clear_difference` means inconclusive, `insufficient_data` means fewer than 5 shared cases). To see why cases failed, use `get_eval_results` / `get_eval_result` or the console URL.

## Sorting failures

After a run with failures, `sf eval sort` (or `sort_eval_failures`) suggests a bucket for each failed result: `agent_wrong` (change the agent or stage), `grader_wrong` (fix the grader), `case_wrong` (fix the dataset) or `unclear`, plus a failure type and a confidence. Ask first like a run: it sends each failed result's case, output and grader reasons to TypeSafe Jev (needs a key) or to the judge model's provider. Never accept suggestions for the human; accepting tags results and is done in the console or API. Read the buckets before editing the agent: a failure that belongs to a grader or a scenario is not fixed by changing the agent.

## Agent evals

An agent eval has `target: { kind: agent, agent: <id> }`; the agent must exist as `agents/<id>.agent.yaml` in the project (disabled is fine, archived is not). Cases are **scenarios**: `input.script` (a list of user messages, deterministic and cheap) or `input.persona` + `goal` + `opening` (a simulator model plays the user). A `conversation:` block sets `mode`, `max_turns`, `tools` and `approvals`. Graders add `tool_calls`, `conversation_check` and `goal_reached`; `schema` does not apply. There is no `sf eval new`: write the files by hand (the sample is `examples/evals/support-sample.*`).

- Validate with `sf eval validate <id> --strict --json` (free). Fix `eval.agent_not_found`, `eval.grader_not_applicable` and `dataset.input_mismatch` findings first.
- A run costs more than a stage run: agent turns, simulator calls and judge calls, with a default cap of `max_cost_usd: 1`. Say so before asking for a yes. A conversation that has started always finishes, so spend can pass the cap slightly.
- **Tools are read-only by default**: write, shell and unlisted MCP tools are stubbed and recorded, never executed, and calls that would ask first are recorded and denied. Never turn on `conversation.tools: real` yourself. It needs `allow_real_tools: true` in the file and `--allow-real-tools` (CLI) or `allow_real_tools: true` (`run_eval`) on the run, and it lets the agent change the project. Ask the human and recommend a throwaway copy.
- `sf eval run --json` for an agent eval adds `target_kind: "agent"`, `agent_id`, `agent_revision`, `mean_turns`, `mean_tool_calls` and `tools_policy`. Report those with the usual numbers. Conversations vary more than single outputs, so use 3 or more repeats and quote `reliability` (pass^k), which is stricter than the pass rate.
- To see why a conversation failed, `get_eval_result` returns the conversation (messages, tool calls with `policy_outcome` of `ran`, `stubbed`, `mocked`, `would_ask_first` or `denied`, `final_reply`, `stop_reason`). A stubbed tool is expected under `read_only`, not a bug. Statuses `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_AGENT_EMPTY_REPLY` (the provider returned nothing; not graded) and `EVAL_SIMULATOR_ERROR` mean the conversation did not finish. After 5 consecutive empty-reply or failed cases the run stops as `failed`; check the provider key and rate limits (an OpenRouter `:free` model can hit its daily limit) before rerunning.
- The run uses the agent's current revision and records it. Compare two runs of the same agent with `sf eval compare`; it shows what changed in the agent.
- Running sends the scenario to the agent's model, and the conversation to the simulator and the judge. Eval sessions are hidden from the agent's lists and Inbox.

## Limits to state when relevant

- Pipeline-level overlays (entry `mcp`, `secrets`, `requires`, wrapper `completion`, `channels`, `schemas`, `include`) are not applied when a pipeline stage is evaluated, so the stage can behave differently than inside its pipeline.
- Cases run with no checkout; a stage that needs a repository cannot be evaluated yet. A stage that stops at a HITL gate records an error for that case.
- Not built: `command` graders, judge calibration, scheduled or CI-triggered evals, deleting an eval in the console. For agents also: red-teaming and generated scenarios, voice and channel evals, a `groundedness` grader, a revision picker.
- Running sends case inputs to the stage's model and, for rubric graders, inputs and outputs to the judge's provider. `code` graders run JavaScript on this machine.
