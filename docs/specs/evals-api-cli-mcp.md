# HTTP API, CLI and MCP surface

Part of the [Evals epic](evals.md). Used by stories 13 (HTTP), 14 (CLI), 15 (MCP) and by every UI story. The console, CLI and MCP all call the **same functions**; the transports only parse input and format output. JSON output and exit codes are part of the public contract (`AGENTS.md`): once released they do not change shape without a version note in `docs/ci.md`.

Conventions to follow exactly (read `src/server/triggerRoutes.ts` first and copy its patterns):

- Routes are handled in a new `src/server/evalRoutes.ts` exporting `handleEvalRoutes(req, res, deps)` and registered in `src/server/http.ts` next to `handleTriggerRoutes`.
- Authentication, host allow-listing and audit logging are whatever the existing routes use. Mutating routes write an audit record the way trigger routes do.
- The project is selected by a `project_root` query parameter (GET) or body field (POST/PUT) exactly as trigger routes do, resolved with the existing catalog-root helpers. Paths in requests and responses are **project-relative**.
- Error body: whatever shape the trigger routes use for `{ error, ... }`, plus `code` (the codes in [result-schema.md](evals-result-schema.md#error-codes-stored-in-error_code-returned-by-the-api)). Never include secrets, request URLs or provider bodies.
- Field names are `snake_case` on the wire (like the rest of the API). TypeScript types in `ui/src/api/types.ts` mirror them.
- All list endpoints return `{ items: [...], next_cursor: string | null }` and accept `limit` (default 50, max 200) and `cursor`.

## Evals

| Method and path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/evals` | `project_root?`, `target_pipeline?`, `target_stage?`, `target_file?`, `q?` | `200 { items: EvalListItem[], banner: RegressionBanner \| null, footer: { evals, datasets, cost_last_7_days } }` | Scans `catalog.evals` roots. Includes evals that fail validation (`valid: false`) so they can be fixed. `target_*` filters return the evals that test one stage (the Catalog inspector uses them). `q` matches eval id, name, stage id and dataset name. Status, banner and footer follow [List status](evals-result-schema.md#list-status-evals-list-srcevalsliststatusts). |
| `GET /api/evals/:id` | `project_root?` | `200 EvalDetail` | `id` is the eval id. 404 `EVAL_NOT_FOUND`. |
| `POST /api/evals/validate` | `{ project_root?, definition? , yaml?, path? }` exactly one of `definition` or `yaml` | `200 { findings, derived_yaml, definition }` | Dry run: nothing written, nothing run. Powers form/YAML sync and the Review step. `derived_yaml` is what saving would write. |
| `POST /api/evals` | `{ project_root?, definition, directory? }` | `201 EvalDetail` | Writes `<evals root or directory>/<id>.eval.yaml`. Fails 409 `EVAL_EXISTS` if the id exists. 422 `EVAL_INVALID` with findings if there are errors. |
| `PUT /api/evals/:id` | `{ project_root?, definition? \| yaml?, base_hash }` exactly one of the two | `200 EvalDetail` | Rewrites the file ([edit rules](evals-file-schema.md#writing-the-file-used-by-story-12)). 409 `FILE_CHANGED { current_hash }` when `base_hash` is stale. 422 `EVAL_INVALID`. |
| `POST /api/evals/sample` | `{ project_root? }` | `201 { eval_id }` | Installs the sample project files from `examples/evals/` into the writable catalog roots (names are fixed in story 24) when absent, and returns the sample eval id. 409 `SAMPLE_EXISTS` if already installed (the UI then just opens it). |
| `POST /api/evals/try` | `{ project_root?, eval_id?, definition?, case_id?, case? }` exactly one of `eval_id` or `definition`; exactly one of `case_id` (a case of the eval's dataset) or `case` (an inline case, for the wizard where nothing is saved yet) | `200 TryResult` | Runs **one case once** with the eval's graders, **stores nothing in eval tables** (the stage run exists with origin `eval`; its cost is returned). Uses the definition's settings but `repeats = 1`. Refused with 409 `EVAL_RUN_ACTIVE` while an eval run is active (P9). "Re-run this case" in the case drawer uses this too. |

`EvalListItem`: `{ id, name, description, type, path, target: { kind, pipeline_path?, stage_id?, file?, label }, dataset_path, dataset_cases, repeats, grader_count, rubric_count, valid, finding_count, status: "never_run"|"passing"|"saturated"|"regressed"|"failing", last_run: RunHeadline | null, last_run_delta_pts: number | null, trend: [{ run_number, passed, pass_rate }] }`.

`RegressionBanner`: `{ eval_id, previous_pass_rate, last_pass_rate, criteria_dropped, last_run_number, previous_run_number }`.

`EvalDetail`: `{ id, path, file_hash, definition, yaml, findings, runs_count, last_run: RunHeadline | null }`. `file_hash` is sha256 of the file bytes and is the `base_hash` for edits.

`RunHeadline`: `{ eval_run_id, run_number, status, passed, pass_rate, pass_rate_ci, results_executed, cost_total, finished_at, fingerprint, label }`.

`TryResult`: `{ result: ResultDetail, stage_run_id, cost_usd }`.

## Datasets

| Method and path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/datasets` | `project_root?` | `200 { items: DatasetListItem[] }` | `{ id, path, format, cases, hash, editable, used_by: evalId[], findings_count }`. `id` = file stem. |
| `GET /api/datasets/:id` | `project_root?`, `eval_id?`, `offset`, `limit` (≤ 200), `tag?`, `q?`, `filter?` (`all`\|`invalid`\|`tagged`) | `200 DatasetDetail` | `{ id, path, format, hash, editable, cases_total, invalid_total, tagged_total, tags: {tag: count}, input_fields: [{ name, required }], cases: (Case & { input_check: { valid: boolean, message?: string } \| null })[], findings, used_by }`. `input_check` is computed against the target stage of `eval_id` (default: the first eval in `used_by`); `null` when no eval uses the dataset. `q` substring-matches `id`, `title`, and the JSON of `input`. `input_fields` come from that stage's `io.input.schema` top-level properties (empty when unknown). |
| `POST /api/datasets/preview` | `{ project_root?, format: "jsonl"\|"json"\|"csv", content: string, delimiter?, mapping?, target?: { pipeline_path?, stage_id?, file? } }` | `200 { columns?, rows: [{ index, case, status: "ready"\|"skipped", reason? }], findings, counts: { ready, skipped } }` | Parses without saving. `content` is the file text (UTF-8). `mapping` is the [upload mapping](evals-dataset-format.md#upload-mapping-console-upload-dialog) (stage field → source column). With `target`, each row is checked against the stage's input schema (`ready`/`skipped`); without it every parsed row is `ready`. |
| `POST /api/datasets` | `{ project_root?, name, cases: Case[] , directory? }` or `{ name, source: "sample", target }` or `{ name, source: "runs", target, run_ids: string[] }` or `{ dataset_id, mode: "append"\|"replace", cases: Case[] }` (add rows from an upload to an existing `.jsonl` dataset, with `base_hash`) | `201 DatasetDetail` | Writes `<datasets root or directory>/<name>.dataset.jsonl` (name `^[a-z0-9][a-z0-9-]{0,62}$`). Assigns ids to cases without one (`c001`…, continuing after the highest in use when appending). 409 `DATASET_EXISTS`, 409 `FILE_CHANGED`. |
| `PATCH /api/datasets/:id/cases` | `{ base_hash, ops: Op[] }` | `200 DatasetDetail` | `Op` = `{ op: "add", case } \| { op: "update", id, case } \| { op: "delete", id } \| { op: "set_tags", id, tags }`. Only for `.jsonl` (else 409 `DATASET_READ_ONLY`). 409 `FILE_CHANGED`. All ops apply or none. |
| `POST /api/datasets/:id/convert` | `{ base_hash }` | `201 DatasetDetail` | `.json`/`.csv` → writes `<name>.dataset.jsonl` next to it. 409 if that file exists. |
| `GET /api/datasets/candidates` | `target` (`pipeline_path`+`stage_id` or `file`), `limit` | `200 { items: [{ run_id, finished_at, preview }] }` | Past stage runs for "From past runs" (excludes `origin = eval`). Shape of `preview`: the first 160 chars of the JSON of the recorded stage input. |

## Eval runs

| Method and path | Body / query | Success | Notes |
|---|---|---|---|
| `POST /api/evals/:id/runs` | `{ project_root?, repeats?, judge?, model?, max_cost_usd?, case_ids?, tags?, only_failed_from?, label?, started_via? }` | `202 { eval_run_id, status: "queued" }` | Validates (422 `EVAL_INVALID` with findings), checks the engine (503 `EVAL_ENGINE_UNAVAILABLE` / `EVAL_NODE_TOO_OLD`), then starts. 409 `EVAL_RUN_ACTIVE` if one is running (P9). `case_ids`, `tags` and `only_failed_from` are mutually exclusive; `tags` selects cases having **any** listed tag; `only_failed_from` (an eval run id of the same eval) selects cases with at least one failed executed result in that run (the run dialog's "Failed last time"). `started_via` defaults to `console`; the CLI/MCP set theirs. |
| `GET /api/evals/:id/runs/estimate` | same options as the start body, as query | `200 { results_total, stage_calls, judge_calls, estimate_usd: number\|null, estimate_seconds: number\|null, judge_included: boolean, based_on_run_number: number\|null }` | See [cost estimate](evals-result-schema.md#cost-estimate). |
| `GET /api/evals/:id/runs/:runNumber` | none | `200 EvalRunDetail` | The console addresses runs by number (`#/evals/<id>/runs/14`). 404 `EVAL_RUN_NOT_FOUND`. |
| `GET /api/eval-runs` | `eval_id?`, `status?`, `project_root?`, list params | `200 { items: RunHeadline[] }` | Newest first. |
| `GET /api/eval-runs/:id` | none | `200 EvalRunDetail` | While running, returns progress; poll every 1.5 s. |
| `GET /api/eval-runs/:id/results` | `status?` (`passed`\|`failed`\|`errored`\|`flaky`), `grader?`, `q?`, `tag?`, list params | `200 { items: ResultRow[] }` | One row per **case** (repeats folded): `{ case_id, title, tags, repeats: [{ repeat_index, status, passed, score }], pass_fraction, mean_score, failed_graders: string[], latency_ms_p50, cost_usd, failure_tags }`. |
| `GET /api/eval-runs/:id/results/:caseId` | none | `200 { case, repeats: ResultDetail[] }` | `ResultDetail`: `{ repeat_index, status, error_code?, error_message?, stage_run_id, output, latency_ms, cost_usd, tokens_in, tokens_out, score, passed, grades: Grade[], budget_warnings, review: { label, note } | null, tags }`. |
| `PUT /api/eval-runs/:id/results/:caseId/:repeat/review` | `{ label?: "pass"\|"fail", note?: string, tags?: string[] }` | `200 { label, note, tags }` | The author's review. `label` and `note` are stored as given (`note` ≤ 500 chars; omit to leave unchanged; `null` clears). `tags` replaces the tag set and is accepted **only for results the system marked failed** (`passed = 0`, else 400 `EVAL_TAGS_ON_PASSED_RESULT`). New tag names join the eval's failure-type vocabulary. The review is saved with the result and read back in `ResultDetail.review`. |
| `GET /api/evals/:id/failure-types` | none | `200 { items: string[] }` | The author's vocabulary, ordered by most recent use. **Not seeded**: Stageflow is domain-agnostic, so the designed names ("Missed an expected issue" etc.) are mockup content only. |
| `POST /api/eval-runs/:id/cancel` | none | `200 EvalRunDetail` | Idempotent on a finished run. |
| `DELETE /api/eval-runs/:id` | none | `204` | 409 while running. |
| `GET /api/eval-compare` | `a`, `b` (eval run ids) | `200 CompareResult` | [compare rules](evals-result-schema.md#compare-compareruns-a-b). 400 `EVAL_COMPARE_MISMATCH`. |
| `GET /api/eval-runs/:id/export` | `what` = `results` (default) or `config` | `200` JSON file (`Content-Disposition: attachment; filename=<eval>-run-<n>-<what>.json`) | `results`: `EvalRunDetail` plus every `ResultDetail`. `config`: the config snapshot only. |
| `GET /api/eval-engine` | none | `200 { installed, version, pinned, node, node_ok, install_command }` | For the console's empty/blocked states. |

`EvalRunDetail`: `{ eval_run_id, run_number, eval_id, status, status_reason, passed, label, started_via, created_at, started_at, finished_at, progress: { results_done, results_total, cost_usd, max_cost_usd, cases_total }, config: <snapshot>, fingerprint, components, stats: Stats | null }`. `stats` is `null` for a run with no executed results yet. `Stats` is the object computed by `src/evals/stats.ts` (all fields of the [statistics table](evals-result-schema.md#statistics-srcevalsstatsts)).

`Grade` as in the table columns, snake_case, with `details` parsed from `details_json`.

While a run is `running`, `EvalRunDetail.live` is `[{ case_id, repeat_index, phase: "stage_running"|"grading"|"done" }]` for results not yet finished (from memory; absent once the run is finished or after a Host restart). The live page combines it with `results` rows.

### Internal endpoint (not part of the public API)

`POST /api/evals/internal/run-case` with `Authorization: Bearer <per-run token>`, body `{ eval_run_id, case_id, repeat_index }`, response is a `RunCaseResult` as JSON. Used only by the promptfoo provider subprocess ([engine-interface.md](evals-engine-interface.md#generated-config)). Rejects with 401 if the token is not the one the manager issued for that run. Not logged with the token. Not in `docs/`.

## CLI

New file `src/cli/evalCommand.ts` (`EVAL_USAGE`, `runEvalCommand`), wired in `src/cli.ts` the way `trigger` is (the command list near the top and the dispatch). The CLI talks to the Host over HTTP like `sf trigger` and `sf run-stage` do (`ensureGlobalService`, `src/cli/hostClient.ts` helpers); it adds `httpListEvals`, `httpStartEvalRun`, etc. there.

```
sf eval list [--json]
sf eval show <id|path> [--json]
sf eval validate [<id|path>] [--json] [--strict]
sf eval run <id|path> [--repeats <n>] [--judge <model>] [--model <id>] [--max-cost <usd>]
                      [--case <id> ...] [--tag <tag> ...] [--label <text>] [--no-wait] [--json]
sf eval runs [<evalId>] [--json]
sf eval runs show <evalRunId> [--json]
sf eval runs cancel <evalRunId>
sf eval runs delete <evalRunId>
sf eval compare <evalRunIdA> <evalRunIdB> [--json]
sf eval datasets [--json]
sf eval engine status [--json]
sf eval engine install
```

- `<id|path>`: a bare id resolves against the project's evals; a path resolves against the current directory (like `--pipeline`). The project root is resolved with `src/cli/resolveCliProjectRoot.ts`, same as other commands.
- `sf eval run` **waits by default** and prints a one-line progress to stderr (`results_done/results_total`, cost) when stderr is a TTY; `--no-wait` prints the run id and exits `0` immediately.
- Exit codes (P8): `0` the run completed and `passed`; `1` anything else, including below threshold, `failed`, `cancelled`, `budget_stopped`, validation errors, engine unavailable, and usage errors. `--no-wait` returns `0` after a successful start. `sf eval validate` exits `1` when there are errors (or warnings with `--strict`).
- `--json` for `run` prints, on stdout, one document: `{ outcome: "passed"|"below_threshold"|"failed"|"cancelled"|"budget_stopped", eval_run_id, eval_id, pass_rate, pass_rate_ci, threshold, results: { executed, passed, errored }, reliability, cost_total, fingerprint, url }`. Validation failure prints a validate-shaped document (`ok:false`, `findings`) with no `eval_run_id`, like `sf run --json` does. `url` is the console link `<base>/#/evals/<id>/runs/<evalRunId>`.
- Help text is added to the top-level usage in `src/cli.ts` and documented in `docs/cli-reference.md` (story 24).

## MCP tools

New `src/mcp/evalTools.ts` exporting a registration function called from where trigger tools are registered (find it by following the `triggerTools` import; copy that structure, including the `textResult` helper, zod input schemas, audit writes and `McpToolDeps`). Tools:

| Tool | Input | Output |
|---|---|---|
| `list_evals` | `{ project_root? }` | `{ items: EvalListItem[] }` |
| `get_eval` | `{ eval_id, project_root? }` | `EvalDetail` |
| `validate_eval` | `{ eval_id? , yaml? , project_root? }` | `{ findings }` |
| `run_eval` | `{ eval_id, repeats?, judge?, model?, max_cost_usd?, case_ids?, tags?, label?, wait?: boolean, timeout_ms? , project_root? }` | with `wait: false` (default): `{ eval_run_id }`; with `wait: true`: the `EvalRunDetail` when finished or `{ eval_run_id, status: "timeout" }` |
| `get_eval_run` | `{ eval_run_id }` | `EvalRunDetail` |
| `list_eval_runs` | `{ eval_id?, status?, limit? }` | `{ items: RunHeadline[] }` |
| `get_eval_results` | `{ eval_run_id, status?, grader?, limit?, cursor? }` | `{ items: ResultRow[], next_cursor }` |
| `get_eval_result` | `{ eval_run_id, case_id }` | `{ case, repeats }` |
| `cancel_eval_run` | `{ eval_run_id }` | `EvalRunDetail` |
| `compare_eval_runs` | `{ a, b }` | `CompareResult` |

No MCP tool writes eval or dataset files in release 1 (authoring is through files, the console and the CLI). The skills (`skills/`) mention the tools in story 24.

---

# Release 2: agents

Part of the [Evals for agents plan](evals-agents.md). Same conventions as above (snake_case, project-relative paths, same error body plus `code`, list shape). Agent evals use the **same routes, the same run lifecycle and the same manager**; this section lists every field that gains an agent variant and the few additions. Used by A09 (read models), A10 (transports), A12/A13 (UI client). Stage requests and responses do not change: every new key is **absent** (not `null`) for stage evals unless noted.

## Evals

- `GET /api/evals`: new filters `target_kind` (`stage` \| `agent`) and `agent` (an agent id; returns evals that test that agent, used by the agent page). `q` also matches the agent id. `EvalListItem.target` is a union: `{ kind: "stage", pipeline_path?, stage_id?, file?, label }` or `{ kind: "agent", agent_id, agent_name, model, revision, label }` (name, model and revision come from the **last run's snapshot** when one exists, else from the live agent; the agent may since have been edited or deleted: `agent_name` falls back to the id). `EvalListItem` adds `conversation: { mode, max_turns, tools, approvals }` for agents.
- `GET /api/evals/:id` / `POST /api/evals` / `PUT /api/evals/:id` / `POST /api/evals/validate`: `definition` and `yaml` accept the release 2 file shapes ([file-schema](evals-file-schema.md#release-2-agents)); findings are those listed there; `derived_yaml` is what `createEvalFile` would write. `EvalDetail` adds `agent: { id, name, model, revision, enabled, archived, tools: [{ id, risk, class }], ask_first: string[], issues: string[] } | null` (live agent, for the editor and warnings).
- `GET /api/evals/agent-targets` (new, `project_root?`): `{ items: [{ id, name, model, revision, enabled, tools: [{ id, risk, class }], ask_first: string[], evals_count, issues: string[], unavailable_reason: "archived" | "invalid" | null }] }`. Archived agents are listed with `unavailable_reason: "archived"` so the picker can grey them; disabled agents are selectable. Never lists eval sessions. `class` is the A05 classification (`read`, `write`, `shell`, `destructive`, `external`, `mcp_unknown`, `sub_agent`, `browser`, `operator_only`).
- `POST /api/evals/try`: accepts an agent `definition` and an inline `case` (a scenario) or a `case_id`. The reply is `TryResult`: `{ result: ResultDetail, stage_run_id: null, cost_usd }` where `result.output` is the conversation subject, `result.grades` as usual. The eval session is deleted after the response (nothing is stored in eval tables; `result.subject_ref` is `null`). It runs one conversation once, with the definition's settings and `repeats = 1`, and honors the same consent rule: `tools: real` needs `allow_real_tools: true` in the body (422 `EVAL_REAL_TOOLS_NOT_CONFIRMED`). It can take minutes: clients must not use short timeouts; `409 EVAL_RUN_ACTIVE` while an eval run is active (P9).
- `POST /api/evals/sample`: gains `{ kind?: "stage" | "agent" }` (default `stage`); the agent sample is A14.

## Datasets

- `GET /api/datasets/:id?eval_id=<agent eval>`: `input_check` is computed with the scenario check; `input_fields` is the fixed list `[{ name: "mode", required: false }, { name: "opening", required: <mode simulated> }, { name: "persona", required: <simulated> }, { name: "goal", required: <simulated> }, { name: "facts", required: false }, { name: "script", required: <script> }, { name: "tool_mocks", required: false }]` (the `required` flags use the eval's `conversation.mode`). `expected.*` columns work as before.
- `POST /api/datasets/preview`: `target` may be `{ agent_id }`; the `mapping` accepts the agent targets listed in [dataset-format](evals-dataset-format.md#csv-and-the-upload-dialog); a mapping of `input.script` / `input.tool_mocks` returns `400 EVAL_INVALID` with finding `dataset.mapping_unsupported_field`. Rows are `ready`/`skipped` by the scenario check.
- `POST /api/datasets`: gains `{ name, source: "sessions", target: { agent_id }, session_ids: string[] }` (A13) building script scenarios from finished non-eval sessions. `GET /api/datasets/candidates?agent=<id>` returns `{ items: [{ session_id, updated_at, preview, turns, tools: string[] }] }` for that agent's finished non-eval sessions (the stage form of the route is unchanged).

## Eval runs

- `POST /api/evals/:id/runs`: the body gains `user_model?`, `allow_real_tools?: boolean`, `tools?: "read_only" | "mocked"`, `approvals?: "deny" | "record_only"` (the last two are **safer-only overrides**: lowering safety is `422 EVAL_INVALID`). `model` on an agent eval overrides the agent's model for the run. Rules, in order: validate (`EVAL_INVALID` with findings, including `eval.agents_unavailable`), tool-policy consent (effective `tools` is `real` and the file lacks `allow_real_tools: true` -> `eval.real_tools_not_allowed` inside `EVAL_INVALID`; file has it but the body lacks `allow_real_tools: true` -> `422 EVAL_REAL_TOOLS_NOT_CONFIRMED`), engine check, `409 EVAL_RUN_ACTIVE`. The run reads the agent's **current revision once** and records it (the body cannot choose a revision, owner decision 5).
- `GET /api/evals/:id/runs/estimate`: same query options plus `user_model`, `tools`, `approvals`. Response keeps `results_total`, `stage_calls` (= conversations for agents), `judge_calls`, `estimate_usd`, `estimate_seconds`, `judge_included`, `based_on_run_number`, and for agent evals adds `target_kind: "agent"`, `simulator_calls: number` (0 in script mode) and `estimate_basis: "previous_run" | "assumptions" | null`. Rules: [result-schema](evals-result-schema.md#cost-estimate-agents).
- `EvalRunDetail`: `config` is the snapshot (agent target variant); `stats` gains `mean_turns`, `mean_tool_calls` (agent runs only; `null` when no data); `components` gains `agent`; `live[].phase` gains `agent_running`; the existing stale-config block `current` carries `agent_revision` and `agent_definition_hash` for agent runs (what the agent is now) next to the stage hashes. `RunHeadline` is unchanged.
- `GET /api/eval-runs/:id/results`: `ResultRow` gains `turns` and `tool_calls` (mean per case). Status values, `status` filters and `repeats[].status` are unchanged (stored values; see [mapping](evals-result-schema.md#status-and-error-code-mapping-for-agents)).
- `GET /api/eval-runs/:id/results/:caseId`: `ResultDetail` gains `subject_ref`, `turns`, `tool_call_count`, and for agent runs `agent: { id, session_id } | null` (`session_id` equals `subject_ref`; the console builds the Agent run page link); `stage_run_id` is `null`; `output` is the stored conversation subject. A result whose session was deleted still returns the subject.
- `GET /api/eval-runs?subject_ref=<id>` (new filter; the stage-only `stage_run_id` filter stays): returns the eval run (and number) that owns a result for that session or stage run; used by the agent session banner (A13).
- `GET /api/eval-compare`: `CompareResult` gains `agent_diff` (agent runs) next to `stage_diff` (stage runs), and the `mean_turns` / `mean_tool_calls` deltas when both runs are agent runs. Mixed or different targets: `400 EVAL_COMPARE_MISMATCH`.
- `DELETE /api/eval-runs/:id`: for agent runs the server first reads the run's session ids, deletes the row, then deletes the eval sessions and their descendants (best effort, like stage runs).
- `GET /api/eval-runs/:id/export`: unchanged shape; results carry the conversation subject.
- Error codes added: `EVAL_REAL_TOOLS_NOT_CONFIRMED` (422), result-level `EVAL_AGENT_FAILED`, `EVAL_AGENT_TIMEOUT`, `EVAL_SIMULATOR_ERROR`, `EVAL_GRADER_NOT_APPLICABLE`.

### Internal endpoint (agents)

`POST /api/evals/internal/run-case` is unchanged in request; for agent plans the response is the agent `RunCaseResult` ([engine-interface](evals-engine-interface.md#provider-reply-and-metadata)). Still internal, still not in the docs.

## CLI

No new subcommand. **There is no `sf eval new`**; the plan's `sf eval new --agent` is dropped (owner decision 12): agent evals are authored in the console or by hand. Existing commands accept agent evals:

```
sf eval run <id|path> [existing flags] [--user-model <model>] [--allow-real-tools]
```

- `list`, `show`, `validate`, `runs`, `runs show`, `compare`, `datasets` print agent targets (`Agent <id> r<revision>`), the conversation settings in `show`, and for results turns and tool-call counts. `validate` prints the release 2 findings.
- `--model` on an agent eval overrides the agent's model; `--user-model` overrides the simulator. `--allow-real-tools` is the per-run consent: when the effective policy is `real` and the flag is missing, the command exits `1` without starting (`--json`: `{ ok: false, code: "EVAL_REAL_TOOLS_NOT_CONFIRMED", message }`); with the flag it prints one stderr line "Warning: real tools can change files and call services from this machine." The flag has no effect on other policies. The safer-only `tools`/`approvals` overrides are API/MCP fields, not CLI flags.
- `sf eval run --json`: the release 1 document, plus (agent targets only) `target_kind: "agent"`, `agent_id`, `agent_revision`, `mean_turns`, `mean_tool_calls`, `tools_policy`. Stage documents are unchanged. Exit codes are unchanged (`0` only when the run completed and passed). Documented in `docs/ci.md` as additive.

## MCP

The ten tools keep their names and accept/return agent targets. Additions: `run_eval` input gains `user_model?`, `allow_real_tools?`, `tools?`, `approvals?` (same rules and the same `EVAL_REAL_TOOLS_NOT_CONFIRMED` error as the API); `get_eval_result` returns the conversation subject; `list_evals` items and `get_eval` carry the agent variants; `get_eval_run` carries `mean_turns` / `mean_tool_calls`. The `run_eval` description must state that agent runs call the agent's model, a simulator model and the judge, can cost much more than stage runs, and that tools are read-only by default. Descriptions that say "stage" (`model` = "Override the stage model") become "stage or agent". MCP still writes no eval or dataset files. The eval-run tools are **not** granted to agents that run inside an eval (`stageflow.run_eval` is always blocked, owner decision 10).
