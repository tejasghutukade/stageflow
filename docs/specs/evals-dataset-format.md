# Dataset format (`*.dataset.jsonl|json|csv`)

Part of the [Evals epic](evals.md). Contract for dataset files, used by story 03 (loader), story 12 (write path) and story 18 (UI).

## Case shape

A case is a JSON object. Keys:

| Key | Type | Required | Rule |
|---|---|---|---|
| `id` | string | yes | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Unique in the dataset. Stable: never renumbered. |
| `input` | object | yes | Passed as `task.input`. Must validate against the target stage's `io.input.schema` (checked when an eval uses the dataset, not when the dataset is loaded alone). |
| `title` | string | no | ≤ 120 chars. Shown in tables ("null dereference in auth.ts"). |
| `expected` | any JSON | no | Reference data for `reference` graders and rubric context. |
| `tags` | string[] | no | Each `^[a-z0-9][a-z0-9-]{0,31}$`, ≤ 10. Used to filter which cases a run uses. |
| `goal` | string | no | Overrides the eval's `task.goal` for this case. |
| `metadata` | object | no | Free-form. Never read by Stageflow; kept and shown in the case drawer. |

Unknown top-level keys are an error (`dataset.unknown_key`). Datasets are **target-neutral** (epic rule 2): the loader checks only this shape. Matching `input` to a stage is a separate check (`checkDatasetAgainstStage`).

## File formats

**JSONL (`.dataset.jsonl`).** One JSON object per line. Blank lines are ignored. A line that is not valid JSON or not an object is an error naming the 1-based line number.

**JSON (`.dataset.json`).** Either an array of cases or `{ "cases": [...] }`.

**CSV (`.dataset.csv`).** RFC 4180, UTF-8, first row is the header, comma delimiter (uploads may choose another delimiter in the dialog; the stored file is always JSONL). Header names:

| Header | Maps to |
|---|---|
| `id`, `title`, `goal` | the string field |
| `tags` | split on `;` |
| `input.<name>` | `input[<name>]` (one level; use `input.<name>:json` for nested values) |
| `expected.<name>` | `expected[<name>]` (same rule); a bare `expected` column holds a string |
| any header ending `:json` | the cell is parsed as JSON |

This header convention is for **hand-authored CSV dataset files** that the loader reads directly. The console's **upload dialog** handles arbitrary CSVs differently: it maps each field of the stage's input schema to a source column (see "Upload mapping" below) and always writes JSONL.

Cells without `:json` are strings (never guessed as numbers or booleans). An empty cell omits the key. A header that matches none of these is an error (`dataset.csv_unknown_column`), so nothing is silently dropped; the upload dialog's column mapping assigns them first.

## Identity and ordering

- Cases keep file order. The console never reorders.
- A file without `id`s (an upload) is imported with ids assigned `c001`, `c002`, … in order and the **stored JSONL always has ids**. A hand-authored file without ids is an error (`dataset.case_missing_id`) so ids never drift.

## Hash

`dataset hash` = sha256 over the canonical content: each case parsed, keys sorted recursively, serialized as compact JSON, joined by `\n`, in file order. Whitespace and key-order changes do not change the hash; reordering, adding, editing or removing cases do. Shown as 6 hex characters; stored in full. `.json` and `.csv` files hash the **parsed cases the same way**, so converting a file to JSONL does not change its hash.

## Limits (P11)

≤ 5,000 cases; each case ≤ 1 MB serialized; uploaded file ≤ 50 MB. Over a limit: `dataset.too_many_cases`, `dataset.case_too_large`, `dataset.file_too_large`.

## Validation codes

Same finding shape as the eval file (`category: "dataset"`).

| Code | Severity | When |
|---|---|---|
| `dataset.load_error` | error | unreadable file, bad JSON/CSV syntax (message has the line) |
| `dataset.empty` | error | zero cases |
| `dataset.not_object` / `dataset.invalid_shape` | error | a case is not an object, or JSON file is neither array nor `{cases}` |
| `dataset.unknown_key` | error | unlisted case key |
| `dataset.case_missing_id` / `dataset.case_invalid_id` / `dataset.duplicate_id` | error | id rules |
| `dataset.case_missing_input` / `dataset.invalid_field` | error | field rules above |
| `dataset.csv_unknown_column` | error | see CSV |
| `dataset.too_many_cases` / `dataset.case_too_large` / `dataset.file_too_large` | error | limits |
| `dataset.input_mismatch` | warning | from `checkDatasetAgainstStage`: a case's `input` fails the stage's `io.input.schema`. One finding per failing case; `message` names the case id and the validator detail. **Such cases are skipped when an eval run starts** (never run, never graded); the dataset page marks them ("Missing plan"). |
| `dataset.few_cases` | warning | fewer than 5 cases (a small set gives wide error bars) |
| `dataset.untagged_balance` | not built | (deferred balance indicator) |

## Editing in the console (P5)

Only `.dataset.jsonl` files are editable: add a case, edit a case, delete a case, set tags. `.json` and `.csv` datasets are read-only in the console with a "Convert to JSONL" action that writes `<name>.dataset.jsonl` next to the original and leaves the original untouched (the user deletes it). Edits use [atomic writes with a base hash](#atomic-writes).

## Atomic writes

Every write (eval or dataset) is: read current file → compare its content hash with the `base_hash` the client sent → if different, fail with `409 FILE_CHANGED` and the current hash → write to `<file>.tmp-<pid>` in the same directory → `rename` over the target. Never leave a partial file.

## Sample dataset

Story 24 ships `examples/evals/` with a complete sample (pipeline, stage, dataset of 8 cases, eval). The Setup step's "Try sample data" tile writes that dataset (file name `sample-review-diffs.dataset.jsonl`) into the project's dataset root **only when** `checkDatasetAgainstStage` passes for the selected target; otherwise the tile is disabled with the reason. The sample's cases are in the story.

## Upload mapping (console upload dialog)

The dialog is **stage-aware**: it lists the target stage's `io.input.schema` top-level properties (with required/optional from the schema) plus `expected.<name>` rows for any `reference` grader's expected path in the eval that uses the dataset, and lets the author pick a source column for each. The request shape sent to `POST /api/datasets/preview` is:

```json
{ "mapping": { "input.diff": { "column": "diff_text" },
               "input.plan": { "column": "summary" },
               "input.pr_url": null,
               "expected.findings": { "column": "issues", "split": ";" } } }
```

`null` = do not import that field. `split` turns a cell into an array of trimmed non-empty strings. Matching columns by name is the default. Values are strings unless the schema property type is `number`, `integer` or `boolean`, in which case the cell is parsed to that type (a cell that does not parse makes the row **skipped** with that reason). Each preview row gets `status: "ready" | "skipped"` and `reason` (for example `plan is empty`, `diff is required`): a row is skipped when the resulting `input` fails the stage's input schema. Skipped rows are **not imported**. The confirm step offers "Add to the N cases already here" (append, new ids continue after the highest `cNNN` in use) or "Replace all cases".

## "From past runs"

The upload dialog's "From past runs" lists completed stage runs of the selected target stage (pipeline runs where the stage ran, and standalone stage runs, **excluding** `origin = eval` runs). Each candidate shows when it ran and a short input preview. Selecting runs creates cases whose `input` is that run's stage input as recorded, `expected` is empty, `title` is `Run <short id>`, `metadata.source_run` is the run id. The story defines where the recorded stage input comes from after reading the run store.

---

# Release 2: agents

Part of the [Evals for agents plan](evals-agents.md). Datasets stay **target-neutral**: the file format, ids, ordering, hash, limits and atomic writes above are unchanged, and `loadDatasetFile`/`parseDatasetCases` do not change. What changes is how an agent eval **reads** a case: `input` is a **scenario** (a scripted or simulated user), checked by a sibling of `checkDatasetAgainstStage` (A02 `datasetAgentCheck.ts`) instead of a stage `io.input.schema`.

## Scenario case

```json
{"id":"s001","title":"Refund request, angry customer",
 "input":{
   "mode":"simulated",
   "persona":"Annoyed Pro customer, short sentences.",
   "goal":"Get a refund for a double charge on invoice INV-2093.",
   "opening":"I was charged twice and I want my money back.",
   "facts":["invoice INV-2093","charged on the 3rd","Pro plan"],
   "tool_mocks":{"billing.lookup_invoice":{"result":{"status":"duplicate"}}}},
 "expected":{"outcome":"escalated_to_human","tools":["billing.lookup_invoice"],"forbidden_tools":["billing.refund"]},
 "tags":["billing"]}
{"id":"s002","title":"Order status, scripted",
 "input":{"mode":"script","script":["Where is my order 1042?","It was ordered on Monday.","Thanks"]},
 "expected":{"tools":["orders.get_status"]}}
```

Top-level case keys are unchanged (`id`, `input`, `title`, `expected`, `tags`, `goal`, `metadata`; unknown key = `dataset.unknown_key`). For an agent target the top-level `goal` is **ignored** (use `input.goal`).

### `input` keys

Unknown keys inside `input` are allowed by the loader (datasets are neutral) but the agent check reports them as warnings so typos show up: `dataset.scenario_unknown_field` (warning, not skipped).

| Key | Type | Required | Limits | Rule |
|---|---|---|---|---|
| `mode` | `script` \| `simulated` | no | | Per-case override of `conversation.mode`. Effective mode = `input.mode ?? conversation.mode`. |
| `script` | string[] | **script mode** | 1-40 items, each 1-4,000 chars | The user messages, in order. The conversation ends with `stop_reason: script_end` after the last message is answered, or at `conversation.max_turns`, whichever is first. `opening`, `persona`, `goal`, `facts` are ignored in script mode. |
| `opening` | string | **simulated mode** | 1-2,000 chars | The first user message, sent verbatim (no simulator call). |
| `persona` | string | **simulated mode** | 1-1,000 chars | Who the user is and how they write. |
| `goal` | string | **simulated mode** | 1-1,000 chars | What the user wants to achieve. Also read by `goal_reached`. |
| `facts` | string[] | no | ≤ 30 items, each ≤ 300 chars | Things the user knows and reveals only when asked or natural. Never given to graders as truth; they are scenario data. |
| `tool_mocks` | object | no | ≤ 50 keys; each value ≤ 20 KB serialized | Keys are tool grant ids (`billing.lookup_invoice`, `stageflow.get_agent`, `bash`; 1-128 chars, no whitespace). Each value is `{ "result": <any JSON> }` **or** `{ "error": "<text ≤ 1000 chars>" }`, exactly one. Used by `tools: read_only` (for tools that would be stubbed) and `tools: mocked`; ignored by `real`. Keys naming tools the agent is not granted give the eval warning `eval.tool_not_granted`. |

`simulated` mode ignores `script`. A case with `script` and effective mode `simulated` still runs simulated (the script is not a fallback).

### `expected` (agent conventions)

`expected` stays "any JSON" (so `reference` graders can point anywhere). These keys have defined meaning and are type-checked when present:

| Key | Type | Used by |
|---|---|---|
| `outcome` | string ≤ 500 chars | `goal_reached` (fallback goal), `rubric` context, `reference` |
| `tools` | string[] ≤ 50 | `tool_calls` default `must_call` |
| `forbidden_tools` | string[] ≤ 50 | `tool_calls` default `must_not_call` |

A wrong type is `dataset.expected_invalid` (warning; the case still runs and the graders that need the key grade `EVAL_CASE_MISSING_EXPECTED`).

## Per-mode check and findings

`checkDatasetAgainstAgent(cases, conversation)` returns the same finding structure as the stage check. **A case that fails is skipped when a run starts**, counted in the snapshot (`dataset.cases_skipped`, `skipped_case_ids`), shown as invalid on the dataset page ("Missing plan"), and reported by `eval.cases_skipped` / `eval.no_valid_cases` (release 1 codes, reused). One finding per failing case; `message` names the case id and the problem.

| Code | Severity | When |
|---|---|---|
| `dataset.input_mismatch` | warning | **Reused code** (so the console's invalid-row handling is unchanged). Message starts "scenario": missing/empty `script` in script mode; missing `opening`, `persona` or `goal` in simulated mode; a wrong type or length; a `tool_mocks` value that is not exactly one of `result`/`error`; an invalid `mode`. |
| `dataset.scenario_unknown_field` | warning | `input` has a key not listed above (case still runs). |
| `dataset.expected_invalid` | warning | `expected.outcome`, `expected.tools` or `expected.forbidden_tools` has the wrong type. |
| `dataset.mapping_unsupported_field` | error | An upload mapping targets `input.script` or `input.tool_mocks` (see below). |

`dataset.few_cases` and the other release 1 codes are unchanged. There is no "input schema" for an agent dataset: `DatasetDetail.input_fields` returns the fixed scenario field list (see [API](evals-api-cli-mcp.md#release-2-agents)).

## CSV and the upload dialog

- **Hand-authored CSV** keeps the release 1 header rules, so `input.opening`, `input.goal`, `input.persona`, `input.mode`, `expected.outcome`, `title`, `tags` work as plain headers and `input.facts:json`, `input.script:json`, `expected.tools:json` work through the `:json` suffix.
- **The console upload dialog** (always writes JSONL) maps source columns to these targets only: `input.opening`, `input.goal`, `input.persona`, `input.mode`, `input.facts` (with `split`), `expected.outcome`, `expected.tools` (with `split`), `expected.forbidden_tools` (with `split`), `title`, `tags`. **`input.script` and `input.tool_mocks` cannot be mapped from CSV**: they are JSON/JSONL only (plan section 4). A mapping that names them gets `dataset.mapping_unsupported_field`, and the dialog shows the notice "Scripts and tool mocks need a JSON or JSONL file."
- Row rule when previewing: a row is `skipped` with a reason when the resulting scenario fails the check for the effective mode (the effective mode comes from the target eval's `conversation.mode` or a mapped `input.mode`; a new dataset with no eval defaults to `simulated`, so `opening`, `persona`, `goal` are required, and the dialog offers a "Scripted conversations" switch that requires a JSON file instead).
- Cells are strings; `split` produces string arrays; nothing is parsed into numbers.

## Attaching a dataset to an agent target

The eval file's `dataset:` path is the only link. `GET /api/datasets/:id?eval_id=<agent eval>` validates each case with the scenario check and fills `input_check`; datasets used by no eval show `input_check: null`. A dataset may be used by stage evals and agent evals at the same time (each reads `input` its own way), but the console warns when one dataset has both kinds of use ("This dataset is used by a stage eval and an agent eval; most cases will be invalid for one of them").

## "From past sessions" (A13)

For agent targets the upload dialog's "From past runs" becomes **From past sessions**: finished, non-eval sessions of the selected agent. Each selected session becomes a `script` scenario: `input = { mode: "script", script: <its user messages>, opening: <first user message> }`, `title` = the session title (or `Session <short id>`), `expected = { tools: <names of tools it called> }`, `tags: ["from-session"]`, `metadata.source_session = <session id>`. Message text comes from the stored session; tool results are not copied.

## Sample dataset

The agent sample (A14) ships `support-sample.dataset.jsonl`: 6 `script` scenarios, no `persona`/`goal`, so it needs no simulator or judge. The console's "Try sample data" tile for agent targets writes it only when the selected agent matches the sample's expectations (otherwise disabled with the reason).
