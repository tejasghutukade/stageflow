# Finding codes

Codes from `sf eval validate` and from `sf validate` when it scans evals. The message on the finding names the key. This table is the fix.

Trust `ok` and the exit code. With `--strict`, every finding whose category is `eval` fails the command: `summary.errors` counts it and `ok` is false, but `findings[].severity` stays `"warning"`. Dataset findings stay warnings under `--strict`. Human output prints the promoted word; JSON does not.

Validate by id (`sf eval validate <id> --json`). A `stageflow.yaml` that omits `catalog.pipelines` or `catalog.tasks` does not load, and this command then scans only the default `evals/` and `datasets/` directories. A no-argument run can report `ok: true` with no findings while your file was never read. `Eval not found` or `Eval is not in a catalog root` means the file is outside the roots that actually loaded.

## Contents

- Eval errors
- Eval warnings
- Dataset errors
- Dataset warnings
- Not a validate finding

## Eval errors

| Code | Fix |
|---|---|
| `eval.load_error` | The YAML did not parse. Fix the syntax the message quotes. |
| `eval.not_object` | The file must be a mapping, not a list or a scalar. |
| `eval.invalid_version` | Set `version: 1`. |
| `eval.unknown_key` | Remove the key the message names. Typos are not ignored. |
| `eval.invalid_id` | `id` must match `^[a-z0-9][a-z0-9-]{0,62}$`. No underscores or capitals. |
| `eval.id_filename_mismatch` | Make `id` equal the filename stem. |
| `eval.duplicate_id` | Two evals share an id. Rename one. The message lists the other file. |
| `eval.invalid_field` | The message names the key and the type or range it needs. Fix that key. |
| `eval.target_kind_unsupported` | `target.kind` must be `stage`, `agent`, or `internal_agent`. |
| `eval.target_invalid` | A stage target is exactly `pipeline` plus `stage`, or exactly `file`. An agent target is exactly `agent`. Do not set `revision` (the run records it). `internal_agent` uses `profile` only. |
| `eval.target_unresolved` | The pipeline, stage file, or model did not load. The message says which. Set a model on the stage, the pipeline, or `stageflow.yaml`. A path that resolves outside the project root fails the same code. |
| `eval.dataset_unresolved` | The dataset path is missing or resolves outside the project root. Paths are relative to the eval file. |
| `eval.dataset_invalid` | The dataset file has errors of its own. Fix those `dataset.*` findings first. |
| `eval.no_valid_cases` | Every case was skipped (schema or scenario). Fix the cases until at least one remains. |
| `eval.grader_duplicate_id` | Grader ids must be unique. |
| `eval.grader_type_unsupported` | Use `schema`, `field`, `reference`, `code`, `rubric`, `tool_calls`, `conversation_check`, or `goal_reached`. `command` is not available. |
| `eval.grader_invalid` | A rule on that grader is broken. The message names the key (`checks`, `rubric`, `code`, `scale`, `votes`, a path). |
| `eval.grader_not_applicable` | `schema` is stage-only. `tool_calls`, `conversation_check`, and `goal_reached` are agent-only. |
| `eval.schema_grader_without_output_schema` | The stage needs `io.output.schema`, or drop the `schema` grader. |
| `eval.judge_missing` | A `rubric` or `goal_reached` grader has no judge. Set `defaults.judge` or the grader's `judge`. |
| `eval.too_large_run` | Cases times repeats is over 5,000. Cut cases or lower `defaults.repeats`. |
| `eval.agent_not_found` | No `agents/<id>.agent.yaml` for `target.agent`. Create the agent, or fix the id. |
| `eval.agent_archived` | The agent is archived. Restore it or pick another. |
| `eval.agent_invalid` | The agent file does not load. The message quotes the first agent issue. Fix the agent (the `stageflow-agents` skill). |
| `eval.conversation_invalid` | A `conversation` value is out of range or the wrong type. The message names the key. `allow_real_tools` is valid only with `tools: real`. |
| `eval.conversation_not_applicable` | Remove `conversation` and `defaults.user_model`. They are agent-only. |
| `eval.task_not_applicable` | Remove `task`. Agent goals live on the scenario (`input.goal`). |
| `eval.read_only_tools_not_mcp` | `read_only_tools` can list only MCP tools (`server.tool` or `server.*`). `write`, `bash`, and other built-ins stay non-read-only no matter what you write here. Remove them. |
| `eval.real_tools_not_allowed` | `tools: real` without `conversation.allow_real_tools: true`. Do not add that flag unless the user asked for real tools. Prefer `read_only`. |
| `eval.user_model_missing` | A simulated scenario needs `defaults.user_model` or `defaults.judge`. |
| `eval.simulator_unsupported` | `user_model` must be an `anthropic/`, `openai/`, or `openrouter/` id. |
| `eval.internal_agent_hidden` | `kind: internal_agent` while the Host has not set `STAGEFLOW_SHOW_INTERNAL_AGENTS=1`. Leave internal agents alone unless the user asked. |
| `eval.internal_agent_unknown` | `profile` is not a built-in agent id. |
| `eval.internal_agent_real_tools` | An internal-agent eval cannot set `conversation.tools: real`. Use `read_only`. |

## Eval warnings

Report these. They do not fail validation unless `--strict` is on. Under `--strict`, read `ok`, not `severity`.

| Code | Fix |
|---|---|
| `eval.cases_skipped` | Some cases do not match the stage input schema, or are not valid scenarios. They will not run. Fix the cases named in the following `dataset.input_mismatch` lines. |
| `eval.cases_missing_expected` | A `reference` grader's `expected` path is empty on some cases, or a `tool_calls` grader has no rule and the case has neither `expected.tools` nor `expected.forbidden_tools`. Fill the case or drop the grader. |
| `eval.cases_missing_goal` | A `goal_reached` grader and some scenarios have neither `input.goal` nor `expected.outcome`. Add one. |
| `eval.judge_unknown_model` | The judge id is not in the model catalog. An empty catalog does not warn. Connect that provider, or pick an id the catalog lists. A supported provider prefix can still be right when this machine has not logged in. |
| `eval.judge_same_as_stage` | The judge is the same model as the stage or agent. Pick another provider's model. Self-preference is the reason. |
| `eval.judge_unpinned` | The judge id ends in `latest`. Pin a dated id so later runs stay comparable. |
| `eval.judge_votes_no_variation` | `votes` is 3 or 5 and `temperature` is 0, so every vote is the same call. Raise the temperature or set `votes: 1`. |
| `eval.stage_has_gates` | The stage declares `gate_kinds`. Those cases record `EVAL_STAGE_NEEDS_INPUT` and count as failures. Evaluate a stage with no gate, or remove the gate. |
| `eval.stage_needs_checkout` | The stage `requires` a repository. Cases run with no checkout, so the stage can behave differently than in a pipeline. |
| `eval.large_run` | Cases times repeats is over 500. Narrow with `--case` or `--tag`, or lower `repeats`, before spending the cap. |
| `eval.agent_disabled` | The agent file is disabled. Eval sessions still run. The warning goes away if the agent is enabled. Enabling also makes it chat-able; do that only when the user asks. |
| `eval.tool_not_granted` | A grader, `read_only_tools`, or a `tool_mocks` key names a tool the agent does not have. Grant it, or name a tool it has. To assert an ungranted tool is never called, use the case's `expected.forbidden_tools` instead of `must_not_call`. |
| `eval.tools_real` | `tools: real` is on. Real tools change files and call services from this machine. Leave it only when the user has accepted that. |
| `eval.tools_unstubbed_list` | Under `read_only`, the named tools are stubbed and recorded, not executed. That is the default policy. Tell the user. It fails `--strict`. Do not switch to `real` to clear it. |
| `eval.tools_mocked_no_mocks` | `conversation.tools` is `mocked` and no scenario has `tool_mocks`. Add mocks or use `read_only`. |
| `eval.simulator_unknown_model` | `user_model` is not in the model catalog. Same reading as `eval.judge_unknown_model`. |
| `eval.simulator_same_as_agent` | The simulator is the agent's own model. Prefer a different model. |

## Dataset errors

These use category `dataset`. The eval also gets `eval.dataset_invalid` while any of them remain.

| Code | Fix |
|---|---|
| `dataset.load_error` | The file is not readable or a line is not JSON. JSONL is one object per line, no trailing commas. |
| `dataset.empty` | The file has no cases. Add at least one. |
| `dataset.not_object` | A line is not a JSON object. |
| `dataset.invalid_shape` | A JSON dataset is not an array and not `{ "cases": [...] }`. |
| `dataset.unknown_key` | Remove the case key the message names. Allowed keys: `id`, `input`, `title`, `expected`, `tags`, `goal`, `metadata`. |
| `dataset.case_missing_id` | Every hand-written case needs an `id`. |
| `dataset.case_invalid_id` | `id` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. |
| `dataset.duplicate_id` | Two cases share an id. Ids are how results and comparisons line up. Do not renumber the others; give the new case a new id. |
| `dataset.case_missing_input` | Add an `input` object. |
| `dataset.invalid_field` | The message names the field: `input` must be an object, `title` at most 120 characters, `goal` a string, `metadata` an object, `tags` at most 10 strings matching `^[a-z0-9][a-z0-9-]{0,31}$`. |
| `dataset.csv_unknown_column` | A CSV header is not `id`, `title`, `goal`, `tags`, `input.<name>`, `expected.<name>`, or a header ending in `:json`. |
| `dataset.too_many_cases` | Over 5,000 cases. Split the file. |
| `dataset.case_too_large` | A case is over 1 MB. |
| `dataset.file_too_large` | The file is over 50 MB. |
| `dataset.mapping_unsupported_field` | A column mapping targets `input.script` or `input.tool_mocks`. Those cannot come from CSV. Use JSONL. |

## Dataset warnings

| Code | Fix |
|---|---|
| `dataset.input_mismatch` | A stage case does not match `io.input.schema`, or an agent scenario fails its mode (the message starts with "scenario"). The case is skipped at run start. Fix `input`. A skipped case is a hole in the measurement. |
| `dataset.few_cases` | Fewer than 5 cases. Comparisons need 5 shared cases or the verdict is `insufficient_data`. Add cases. |
| `dataset.scenario_unknown_field` | A key inside `input` is not a scenario field. The case still runs. Remove the typo or it is silently ignored. |
| `dataset.expected_invalid` | `expected.outcome`, `expected.tools`, or `expected.forbidden_tools` has the wrong shape. Outcome is a string. The tool lists are arrays of strings. |

## Not a validate finding

`eval.agents_unavailable` is reported when a run is planned, not by `sf eval validate`. The Host has no agent service, or it could not read the agent revision. Start the Host (`sf ui` or `sf mcp`) and retry.

Request codes you will see from run, sort, calibrate, and writes (`EVAL_INVALID`, `EVAL_RUN_ACTIVE`, `EVAL_REAL_TOOLS_NOT_CONFIRMED`, `FILE_CHANGED`, `EVAL_CLASSIFIER_UNAVAILABLE`, `EVAL_CALIBRATION_NO_LABELS`, `EVAL_ENGINE_UNAVAILABLE`, `EVAL_NODE_TOO_OLD`) are named in the workflow in `SKILL.md` and in [reading-results.md](reading-results.md) and [triage.md](triage.md). `EVAL_COMPARE_MISMATCH` is named in [reading-results.md](reading-results.md). They are not findings on the file.
