# Evals

An eval runs one stage over a dataset of cases, grades every output, repeats each case, and reports a pass rate with honest error bars. Use it when the human asks whether a stage is any good, or whether a change to a stage made it better or worse. It works for any kind of stage, not only code. This file is the one place the suite describes evals; job skills cite it.

Full docs: Stageflow docs: Evals (checkout: [docs/evals.md](../../../docs/evals.md)), [CLI reference: `sf eval`](../../../docs/cli-reference.md#sf-eval), [MCP: eval tools](../../../docs/mcp.md#eval-tools), [CI: evals](../../../docs/ci.md#evals-in-ci).

## Files

An eval is `evals/<id>.eval.yaml` (target stage, dataset, graders, defaults). Its dataset is `datasets/<name>.dataset.jsonl` (one case per line: `id`, `input`, optional `expected`, `tags`). Sample: `examples/evals/` in the Stageflow repo. YAML keys and validation codes: [docs/yaml-catalog.md](../../../docs/yaml-catalog.md#evals-eval-yaml). Write these with the native Write tool like any catalog file; the cases must match the stage's `io.input.schema`.

## Free and paid

| Action | CLI | MCP | Cost |
|---|---|---|---|
| Check an eval and its dataset | `sf eval validate [<id\|path>] [--strict] [--json]` | `validate_eval` | Free, no model call |
| List, show, read runs and results, compare | `sf eval list`, `show`, `runs`, `runs show`, `compare`, `datasets` (all take `--json`) | `list_evals`, `get_eval`, `list_eval_runs`, `get_eval_run`, `get_eval_results`, `get_eval_result`, `compare_eval_runs` | Free |
| Check the engine | `sf eval engine status --json` | none | Free |
| Install the engine | `sf eval engine install` | none (CLI only) | Free, but downloads about 1.2 GB; needs Node 22.22.0 or newer |
| **Run an eval** | `sf eval run <id\|path> --json` | `run_eval` | **Calls models and costs real money** |
| Stop a run | `sf eval runs cancel <evalRunId>` | `cancel_eval_run` | Stops spending |

Never start an eval run on your own. Tell the human what it will do (cases x repeats stage calls, plus judge calls for rubric graders) and the cost cap (`defaults.max_cost_usd`, default 2; `--max-cost` overrides it), and wait for a yes. Only one eval run is active per Host.

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

## Limits to state when relevant

- Pipeline-level overlays (entry `mcp`, `secrets`, `requires`, wrapper `completion`, `channels`, `schemas`, `include`) are not applied when a pipeline stage is evaluated, so the stage can behave differently than inside its pipeline.
- Cases run with no checkout; a stage that needs a repository cannot be evaluated yet. A stage that stops at a HITL gate records an error for that case.
- Not built: `command` graders, judge calibration, agent evals, scheduled or CI-triggered evals, editing an eval in the console.
- Running sends case inputs to the stage's model and, for rubric graders, inputs and outputs to the judge's provider. `code` graders run JavaScript on this machine.
