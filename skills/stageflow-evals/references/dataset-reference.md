# Dataset reference

A dataset is a file of cases. Stage cases are one input each. Agent cases are scenarios that describe a whole conversation. This file covers the case format, scenario fields, limits and how to build a dataset that tells you something.

## Contents

- Format and case keys
- Stage cases
- Agent scenarios
- Limits and findings
- Building a good dataset
- Editing safely

## Format and case keys

Write `.dataset.jsonl`: one JSON object per line, blank lines ignored. The editing tools only write JSONL. `.dataset.json` (an array, or `{ "cases": [...] }`) and `.dataset.csv` load and run but are read-only to the tools (`DATASET_READ_ONLY`); convert them with `convert_dataset` or the console's **Convert to JSONL**.

| Key | Required | Rule |
|---|---|---|
| `id` | yes | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, unique in the file, stable. Never renumber: results and comparisons are keyed by it. A hand-written case without an id is an error. |
| `input` | yes | Object. For a stage it is the task input; for an agent it is the scenario. |
| `title` | no | Up to 120 characters. Shown in result lists; write what makes the case distinct. |
| `expected` | no | Any JSON. Read by `reference` graders and shown to rubric judges. For agents three keys have meaning (below). |
| `tags` | no | Up to 10, each `^[a-z0-9][a-z0-9-]{0,31}$`. Lets a run pick cases (`--tag`, `tags`) and lets `code` graders branch per case. |
| `goal` | no | Stage cases: replaces the eval's `task.goal` for this case. |
| `metadata` | no | Free-form. Stageflow never reads it. |

Unknown top-level keys are an error (`dataset.unknown_key`). The dataset path in the eval is relative to the eval file.

CSV headers: `id`, `title`, `goal`, `tags` (split on `;`), `input.<name>`, `expected.<name>`; a header ending in `:json` parses the cell as JSON. Scripts and tool mocks for agents cannot come from a CSV mapping; use JSONL.

## Stage cases

`input` becomes the task input and must match the stage's `io.input.schema`.

```jsonl
{"id":"t001","title":"Double charge","input":{"subject":"Charged twice this month","body":"My card was charged 29 dollars twice on the 3rd. Please refund one of them."},"expected":{"category":"billing"},"tags":["billing"]}
{"id":"t002","title":"Export crashes","input":{"subject":"Export button crashes the app","body":"Every time I press Export on a table with more than 500 rows the app closes."},"expected":{"category":"bug"},"tags":["bug","urgent"]}
```

- A case whose `input` does not match the schema is never run. Validation warns (`dataset.input_mismatch`, then `eval.cases_skipped`) and the run records the skip count. If none remain, `eval.no_valid_cases` is an error. A skipped case is a silent hole in the measurement, so treat the warning as a defect.
- `sf eval validate` compares every case with the stage's `io.input.schema` offline, so run it after every dataset edit.
- A stage with no `io.input.schema` accepts any object, so a typo in a key name goes unnoticed. Add the schema.
- Put what a grader needs in `expected`. A `reference` grader with `expected: expected.category` yields an error grade (`EVAL_CASE_MISSING_EXPECTED`) for a case with nothing there, and validation warns (`eval.cases_missing_expected`).

## Agent scenarios

`input` is a scenario. Two modes, set by `conversation.mode` and overridable per case with `input.mode`.

Script mode: fixed user messages, deterministic, cheap, best for regressions.

```jsonl
{"id":"h001","title":"Paid leave allowance","input":{"mode":"script","script":["How many days of paid leave do I get each year?"]},"expected":{"mentions":["25"],"tools":[],"forbidden_tools":["write","edit","bash"]},"tags":["facts"]}
```

Simulated mode: a model plays the user from a persona, a goal and facts.

```jsonl
{"id":"p002","title":"Impatient expense claim","input":{"mode":"simulated","persona":"Impatient, short sentences, wants a yes or no.","goal":"Learn whether a 500 dollar conference ticket needs approval before buying.","opening":"Can I just buy a conference ticket and expense it?","facts":["the ticket costs 500 dollars"]},"expected":{"outcome":"told it needs written manager approval before buying","forbidden_tools":["write","edit","bash"]},"tags":["expenses"]}
```

| `input` key | Mode | Rule |
|---|---|---|
| `mode` | both | `script` or `simulated`. |
| `script` | script | Required. 1 to 40 user messages of 1 to 4,000 characters, sent in order. |
| `opening` | simulated | Required. First user message, sent as written. 1 to 2,000 characters. |
| `persona` | simulated | Required. 1 to 1,000 characters. |
| `goal` | simulated | Required. 1 to 1,000 characters. `goal_reached` reads it. |
| `facts` | simulated | Optional. Up to 30 strings of 300 characters. The user reveals them when asked or natural. |
| `tool_mocks` | both | Optional. Up to 50 tool ids, each `{ "result": ... }` or `{ "error": "..." }`, 20 KB each. |

`tool_mocks` apply under `tools: read_only` (for tools that would be stubbed) and `tools: mocked`, and are ignored under `real`. The agent receives a mock as an error-flagged tool result, so treat mocks as approximate.

`expected` keys with a meaning for agents:

| Key | Effect |
|---|---|
| `outcome` | Text. The fallback goal for `goal_reached` when the scenario has no `input.goal`. |
| `tools` | Array of tool ids. The default `must_call` of a `tool_calls` grader. |
| `forbidden_tools` | Array of tool ids. The default `must_not_call` of a `tool_calls` grader. |

Everything else in `expected` is free (the examples use `mentions` for a `reference` grader). A scenario that fails its mode's check is skipped at run start (`dataset.input_mismatch`, message starts "scenario"); a typo inside `input` warns (`dataset.scenario_unknown_field`) and the case still runs, so read that warning too.

## Limits and findings

- 5,000 cases per file, 1 MB per case, 50 MB per uploaded file. Cases times repeats above 500 warns (`eval.large_run`); above 5,000 is an error (`eval.too_large_run`).
- Fewer than 5 cases warns (`dataset.few_cases`). A comparison needs at least 5 shared cases or its verdict is `insufficient_data`.
- Dataset findings: errors `dataset.load_error`, `dataset.empty`, `dataset.not_object`, `dataset.invalid_shape`, `dataset.unknown_key`, `dataset.case_missing_id`, `dataset.case_invalid_id`, `dataset.duplicate_id`, `dataset.case_missing_input`, `dataset.invalid_field`, `dataset.csv_unknown_column`, `dataset.too_many_cases`, `dataset.case_too_large`, `dataset.file_too_large`, `dataset.mapping_unsupported_field`; warnings `dataset.input_mismatch`, `dataset.few_cases`, `dataset.scenario_unknown_field`, `dataset.expected_invalid`. Fixes are in `finding-codes.md`.

## Building a good dataset

Aim for 15 to 30 cases for a first useful eval. Fewer gives wide error bars: 10 cases with 8 passing is an interval of roughly 50% to 100%, not 80%.

Cover on purpose:

1. **Typical cases**, in proportion to real use. These guard against regressions.
2. **Edge cases**: empty or very long input, odd formatting, missing optional fields, two intents at once.
3. **Cases that must not trigger the behavior**: a clean input for a stage that flags problems; a request the agent must decline. Without negatives a stage that always flags passes.
4. **Ambiguous cases** where the right answer needs judgment. Mark them with a tag such as `ambiguous` and treat their failures as a signal about the grader or the case before the stage.
5. **Known failures** from real runs, added as you meet them. For stages, copy inputs from past runs (`create_dataset` with `source: runs`, or **From past runs** in the console). For agents, build scripts from finished sessions (`source: sessions`; each session becomes a script of its user messages with `expected.tools` set to the tools it called and the tag `from-session`; tool results are not copied).

Rules that keep the numbers honest:

- Write the expected value before you look at the model's output. Do not copy the model's answer into `expected`.
- Use realistic, synthetic or anonymized text. Case inputs are sent to the model and, for judged graders, to the judge's provider. Never put secrets or personal data in a case.
- Tag cases (`billing`, `urgent`, `edge`, `negative`) so you can rerun a slice cheaply and so graders can branch on `testCase.tags`.
- One thing per case where you can. A case that tests three behaviors fails for unclear reasons.
- Do not let an `expected` value depend on the date, a random id or live data.
- Keep ids stable. Add new cases with new ids; fix a wrong case in place and rerun; never reuse an id for a different case.
- For agents, start with script scenarios and add a few simulated ones for what a script cannot reach (persistence, pushback, vague users). Simulated cases cost more and add noise.

## Editing safely

- With file access, edit the JSONL directly and run `sf eval validate`. One JSON object per line; no trailing commas; no pretty-printing across lines.
- A dataset's `base_hash` is a hash of the parsed cases, not of the file bytes, so you cannot compute it with `shasum`. Read it from `sf eval datasets --json` (`hash`) or from the result of the last dataset tool call. An eval file's `base_hash` is different: it is the SHA-256 of the file bytes (`file_hash` in `get_eval`).
- There is no MCP tool that reads or lists datasets. An MCP-only session must first get the cases and `hash` from `sf eval datasets --json` or the file. If neither is reachable, stop and ask the user. Do not send a placeholder `base_hash`.
- `update_dataset_cases` applies a whole `ops` list or nothing. `create_dataset` with `mode: replace` overwrites every case: use `append` unless the user asked to start over.
- Changing a dataset changes what the next run measures. Comparisons across different dataset hashes warn (`dataset_differs`). To compare fairly, keep the dataset fixed while you change the stage or agent, and when you must change the dataset, rerun the baseline on the new one.
