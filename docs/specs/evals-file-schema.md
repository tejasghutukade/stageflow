# Eval file schema (`*.eval.yaml`)

Part of the [Evals epic](evals.md). This is the contract for the file. The loader (story 02), the write path (story 12), the form (stories 17, 22) and the engine plan (story 06) all read this one definition. Do not add keys that are not listed.

## Example

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
    description: Every item in findings has a file and a line number
    checks:
      - { path: "payload.findings[*].file", op: not_empty }
      - { path: "payload.findings[*].line", op: exists }
  - id: finds-expected-issues
    type: reference
    description: Findings mention each issue listed in the case's expected.findings
    weight: 3
    mode: each_mentioned
    path: payload.findings
    expected: expected.findings
  - id: no-invented-files
    type: rubric
    weight: 2
    rubric: |
      Pass if every file named in the review exists in the diff and every quoted line appears in it.
      Fail if the review cites a file, function or line the diff does not contain.
    scale: pass_fail
    examples:
      - verdict: pass
        output: "auth.ts line 42 dereferences session.user without a null check"
        reason: file and line are in the diff
      - verdict: fail
        output: "utils/retry.ts is missing a timeout"
        reason: the diff does not touch utils/retry.ts
  - id: clear-and-actionable
    type: rubric
    rubric: A developer could act on each finding without asking questions.
    scale: 1_to_5
    pass_at: 4
budget:
  latency_ms: 300000
  cost_usd: 0.3
```

## Top level

| Key | Type | Required | Rule |
|---|---|---|---|
| `version` | `1` | yes | Only `1` is accepted. |
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{0,62}$`. **Must equal the filename stem** (`review-findings` for `review-findings.eval.yaml`). Unique in the project. |
| `name` | string | no | Display name, 1–80 chars. Default: `id`. |
| `description` | string | no | ≤ 500 chars. |
| `type` | `capability` \| `regression` | no | Default `capability`. Display and guidance only; no behavior difference. |
| `target` | object | yes | See Target. |
| `dataset` | string | yes | Path to a dataset file, **relative to the eval file's directory** (P6). Must resolve to a file inside the project root. |
| `task` | object | no | `{ goal?, context?, constraints? }`, all strings. Template for the task each case runs with. See "How a case becomes a task". |
| `defaults` | object | no | See Defaults. |
| `graders` | array | yes | 1–20 graders. Unique `id`s. |
| `budget` | object | no | `{ latency_ms?, cost_usd? }`, positive numbers. Per-result **warnings**, never failures. |

Unknown keys at any level are an error (`eval.unknown_key`), so typos are caught.

## Target

Release 1 accepts only `kind: stage` (release 2 adds `kind: agent`: see [Release 2: agents](#release-2-agents)). Exactly one of two forms:

| Form | Keys | Meaning |
|---|---|---|
| Pipeline stage | `kind: stage`, `pipeline: <path>`, `stage: <stage id>` | A stage of a pipeline (a `uses:` stage or an inline stage). The pipeline supplies the pipeline-level `model` default and the stage as materialized by the normal loader. |
| Stage file | `kind: stage`, `file: <path>` | A standalone stage YAML file. Model resolves stage → manifest default (no pipeline tier). |

Paths are relative to the eval file's directory (P6). `kind` is required. Release 2 adds `kind: agent` (see [Release 2: agents](#release-2-agents)); a loader seeing any other kind returns `eval.target_kind_unsupported`.

**Stage version hash** = sha256 of the canonical JSON (sorted keys, no whitespace) of the materialized stage config: the loaded `StageConfig` after model resolution, including `io`, `verify`, `system_prompt`, `mcp`, `gate_kinds`, `timeout_ms`, `model`. Shown as the first 6 hex characters; stored in full. It changes when anything that can change the stage's behavior changes.

## Defaults

| Key | Type | Default | Rule |
|---|---|---|---|
| `repeats` | integer | 3 | 1–10 (P11). |
| `judge` | string | none | A model id `provider/model` from the model catalog. Required if any `rubric` grader has no `judge` of its own. |
| `pass_threshold` | number | 0.8 | `0 < x ≤ 1`. See [scoring](evals-result-schema.md#scoring). |
| `max_cost_usd` | number | 2 | `> 0`. Total of stage runs and judge calls. |
| `concurrency` | integer | 4 | 1–8 (P11). |
| `model` | string | none | Overrides the stage's model for every case (a model id). Recorded in the snapshot. |

A run can override `repeats`, `judge`, `max_cost_usd`, `model`, and choose a subset of cases, without editing the file (the run dialog). Overrides are recorded in the snapshot.

## Graders

Common keys: `id` (same pattern as the eval id, unique in the eval), `type`, `description` (optional, ≤ 200 chars), `weight` (number > 0, default 1), `must_pass` (boolean, default false).

`must_pass: true` means: if this grader fails, the result fails regardless of score, and the grader is **excluded from the weighted mean** (its `weight` is ignored). See [scoring](evals-result-schema.md#scoring).

Each grader has a **grader hash**: sha256 of the canonical JSON of the grader object (all keys, defaults filled in). Displayed as 6 hex characters. It is the unit of "grader version" in the config snapshot.

### `schema`

No extra keys. Passes iff the envelope `status` is `success` **and** `payload` validates against the stage's `io.output.schema`. Validation uses `compilePayloadSchema` / `payloadInstanceMismatch` from `src/envelope/payloadSchema.ts` (the same code the runtime uses). If the stage has no `io.output.schema`, the eval is invalid (`eval.schema_grader_without_output_schema`). Score is 1 or 0. Reason on failure is the validator's message.

### `field`

| Key | Rule |
|---|---|
| `checks` | Non-empty array of `{ path, op, value? }`. All must hold for a pass. |

`path` syntax, evaluated against the **envelope** object `{ status, summary, artifacts, payload }`: dot-separated keys; `[n]` for an array index; `[*]` for "every element". With `[*]`, **every** matched node must satisfy the op; if `[*]` matches nothing, `exists`, `not_empty` and every comparison op **fail** and `length_*` ops evaluate on the empty array's parent as written. Example: `payload.findings[*].line`.

`op` values:

| `op` | `value` | Passes when |
|---|---|---|
| `exists` | none | the path resolves and the value is not `null`/`undefined` |
| `not_empty` | none | exists and is not `""`, `[]`, `{}` |
| `equals` / `not_equals` | any JSON | deep equality / inequality |
| `contains` | string or any | string: substring (case-sensitive); array: element deep-equals `value` |
| `matches` | string | JavaScript regular expression (no flags) tests true on a string value |
| `gte` / `lte` | number | numeric comparison |
| `between` | `[min, max]` | `min ≤ x ≤ max` |
| `in` | array | value deep-equals one element |
| `length_gte` / `length_lte` | integer | string or array length |

Score is 1 if all checks pass, else 0. Reason lists the first failing check as `path op value` and what was found (truncated to 200 chars).

### `reference`

Compares the output with the case's `expected`.

| Key | Rule |
|---|---|
| `mode` | `each_mentioned` or `equals`. Required. |
| `path` | Envelope path of the actual value. Default `payload`. |
| `expected` | Path into the **case** object (`expected.findings`). Required. |
| `pass_at` | Number 0–1, default 1. |

`each_mentioned`: the value at `expected` must be an array of strings. The actual value at `path` is serialized to text (a string stays as is; anything else is `JSON.stringify`). Each expected string counts as found if it appears in that text, **case-insensitive, whitespace collapsed**. Score = found ÷ total. An empty expected array scores 1. Passes when score ≥ `pass_at`.

`equals`: deep equality between the actual and expected values. Score 1 or 0.

If a case has no value at `expected`, the grade is an error `EVAL_CASE_MISSING_EXPECTED` (not a fail): the result is excluded from this grader's stats and reported. Validation warns when some cases lack it.

### `rubric`

| Key | Rule |
|---|---|
| `rubric` | Required string, 1–4,000 chars. What the judge looks for. |
| `scale` | `pass_fail` (default) or `1_to_5`. |
| `pass_at` | Only with `1_to_5`: integer 1–5, default 4. Rejected with `pass_fail`. |
| `judge` | Optional model id overriding `defaults.judge`. |
| `examples` | Optional, ≤ 6. Each `{ verdict: pass \| fail, output: string, reason?: string }` for `pass_fail`, or `{ score: 1–5, output: string, reason?: string }` for `1_to_5`. Shown to the judge. |

The judge sees (in this order): the rubric, the examples, the case `input`, the case `expected` if present, and the stage output (`status`, `summary`, `payload`, artifact names). The exact prompt is fixed in story 11 and versioned by `RUBRIC_PROMPT_VERSION`; that version is part of the snapshot. The judge returns JSON `{ "verdict": "pass"|"fail", "reason": string }` for `pass_fail` or `{ "score": 1-5, "reason": string }` for `1_to_5`. Score for stats: `pass_fail` 1/0; `1_to_5` (v−1)/4. The raw value is stored too.

**Judge-same-as-stage warning:** when the effective judge model equals the stage's effective model, validation emits a **warning** `eval.judge_same_as_stage` (self-preference bias). It is not an error.

### `code`

| Key | Rule |
|---|---|
| `code` | Required string: the body of a JavaScript function. |

The function receives `(output, testCase, context)` where `output` is the envelope object, `testCase` the case, `context = { evalId, runId, repeat }`. It must return a boolean, a number 0–1, or `{ pass: boolean, score?: number, reason?: string }`. Boolean → score 1/0. A number passes when it is ≥ `pass_threshold`. A thrown error or a non-conforming return is an error `EVAL_GRADER_CODE_ERROR`, not a fail. It runs on the author's machine with the author's permissions, the same trust level as a `verify: command` check; docs must say so. Timeout 5 s per call.

## How a case becomes a task

For each (case, repeat) the Host builds a task and starts a stage run:

```
task = {
  id:      "eval-<evalRunId>-<caseId>-<repeat>",
  goal:    case.goal ?? eval.task.goal ?? "Evaluate case <caseId>",
  context: eval.task.context,          // omitted if absent
  constraints: eval.task.constraints,  // omitted if absent
  input:   case.input
}
```

`case.input` is validated against the stage's `io.input.schema` at load time (story 03) and again by the normal run start. No `checkout`, `repository`, `ref` or git identity is set in release 1: stages that need a checkout cannot be evaluated yet, and validation warns when the stage `requires` a repository (`eval.stage_needs_checkout`).

## Validation findings

Findings use the existing `ValidationFinding` shape (`src/config/validateCatalog.ts`): `severity` (`error`/`warning`), `code`, `path` (file), `message`, `category: "eval"`. Codes (exhaustive for release 1):

| Code | Severity | When |
|---|---|---|
| `eval.load_error` | error | YAML does not parse |
| `eval.not_object` | error | document is not a mapping |
| `eval.invalid_version` | error | `version` not `1` |
| `eval.unknown_key` | error | unlisted key (message names it) |
| `eval.invalid_id` | error | bad `id` pattern |
| `eval.id_filename_mismatch` | error | `id` ≠ filename stem |
| `eval.duplicate_id` | error | two evals in the project share an `id` |
| `eval.invalid_field` | error | wrong type or range (message names key and rule) |
| `eval.target_kind_unsupported` | error | `target.kind` not `stage` (release 1) or `stage`/`agent` (release 2) |
| `eval.target_invalid` | error | not exactly one target form |
| `eval.target_unresolved` | error | pipeline, stage id or file not found / does not load |
| `eval.dataset_unresolved` | error | dataset file not found or outside the project |
| `eval.dataset_invalid` | error | dataset file itself fails story 03 validation (parse errors, ids, shape); message summarizes, details are the dataset's own findings |
| `eval.cases_skipped` | warning | some cases fail the stage's `io.input.schema`; they are **skipped when a run starts** and counted in the snapshot (message: how many and the first case id). Not an error, because the dataset page shows them and the author can fix them later |
| `eval.no_valid_cases` | error | after skipping, zero cases remain |
| `eval.grader_duplicate_id` | error | repeated grader id |
| `eval.grader_type_unsupported` | error | type not in `schema field reference rubric code` (`command` gets a specific message: not available in release 1) |
| `eval.grader_invalid` | error | type-specific rule broken |
| `eval.schema_grader_without_output_schema` | error | see `schema` |
| `eval.judge_missing` | error | a rubric needs a judge and none is set |
| `eval.judge_unknown_model` | warning | judge id not in the model catalog (the catalog may be offline) |
| `eval.judge_same_as_stage` | warning | see `rubric` |
| `eval.stage_has_gates` | warning | target stage declares `gate_kinds` (P7) |
| `eval.stage_needs_checkout` | warning | see above |
| `eval.cases_missing_expected` | warning | a `reference` grader and some cases lack the `expected` path |
| `eval.large_run` | warning | cases × repeats > 500 |
| `eval.too_large_run` | error | cases × repeats > 5,000 (P11) |

## Writing the file (used by story 12)

Key order on write: `version, id, name, description, type, target, dataset, task, defaults, graders, budget`. Within a grader: `id, type, description, weight, must_pass`, then type-specific keys in the order of the tables above. Two-space indentation. Block scalars (`|`) for multi-line `rubric` and `code`. Flow style (`{ path: ..., op: ... }`) for `field.checks` items. Omit keys equal to their default **only if they were absent in the file being edited**; when creating a file from the form, write `defaults.repeats`, `defaults.pass_threshold` and `defaults.max_cost_usd` explicitly so a reader sees them. Edits to an existing file preserve comments and unrelated formatting by using the `yaml` library's Document API (the same library the repo already uses); a full rewrite is allowed only when the Document edit cannot represent the change, and the story's tests must show comments survive the common edits.

---

# Release 2: agents

Part of the [Evals for agents plan](evals-agents.md) (approved 2026-10-22; owner decisions 1-12 are final). Story A01 wrote this section; A02 (loader/validator), A10 (write path, API) and A12 (forms) build against it. Facts about agents come from [evals-agents-verification.md](evals-agents-verification.md), which wins over this section if they disagree. Nothing above this heading changes for `kind: stage`; every key below is accepted only behind `target.kind: agent`.

## Example (agent eval)

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
  judge: anthropic/claude-sonnet-4-5
  user_model: anthropic/claude-sonnet-4-5
  pass_threshold: 0.8
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
    args:
      - { tool: billing.lookup_invoice, path: invoice_id, op: matches, value: "^INV-[0-9]+$" }
  - id: one-question-at-a-time
    type: conversation_check
    max_turns: 6
    max_agent_questions_per_turn: 1
    final_reply:
      - { op: not_empty }
  - id: reaches-the-goal
    type: goal_reached
    weight: 3
  - id: stays-polite
    type: rubric
    rubric: The agent stays polite and never blames the customer.
    scale: pass_fail
budget:
  latency_ms: 600000
  cost_usd: 0.6
```

## Top level (agent targets)

| Key | Rule for `kind: agent` |
|---|---|
| `target` | `{ kind: agent, agent: <id> }`. See Agent target. |
| `task` | **Not accepted** (`eval.task_not_applicable`, error). A case's top-level `goal` is also ignored; the scenario goal is `input.goal`. |
| `conversation` | Optional object, only for agent targets (`eval.conversation_not_applicable` on a stage target). See Conversation. All keys have defaults, so omitting it means "script mode, 8 turns, read_only, record_only". |
| `defaults` | The release 1 keys plus `user_model`. `defaults.model` overrides the **agent's** model for every case (recorded in the snapshot); the run dialog calls it the agent model. |
| `graders` | Release 1 types plus `tool_calls`, `conversation_check`, `goal_reached`, subject to the applicability matrix. |
| `budget` | Unchanged; checked **per conversation** (latency = wall clock of the whole conversation, cost = agent + sub-agents + simulator). |

Key order on write: `version, id, name, description, type, target, dataset, task, defaults, conversation, graders, budget`. Within `conversation`: `mode, max_turns, turn_timeout_ms, tools, approvals, read_only_tools, allow_real_tools`. Within `defaults`: release 1 order, then `user_model` after `judge`.

## Agent target

| Key | Type | Rule |
|---|---|---|
| `kind` | `agent` | required |
| `agent` | string | required; must match `AGENT_ID_PATTERN` (`^[a-z][a-z0-9_]{0,63}$`, `src/agents/agentId.ts`) and not be reserved. The agent is found by the Host's agent catalog of the project (`agents/<id>.agent.yaml`). |

`revision` is **never authored**. A run uses the agent's current revision read once when the run starts (owner decision 5) and records it. `pipeline`, `stage` or `file` on an agent target, or `agent` on a stage target, is `eval.target_invalid`. A `revision` key is `eval.target_invalid` with the message "revision is recorded by the run, not authored".

**Agent version hash** = sha256 of the canonical JSON (sorted keys, no whitespace, `src/evals/canonical.ts`) of the revision's parsed `AgentDefinition` after the eval's `defaults.model` override is applied. Shown as 6 hex characters; stored in full. It is stored in the same snapshot and fingerprint slot as the stage version hash (`stage_version_hash`), see [result-schema](evals-result-schema.md#release-2-agents).

Resolution (A02 `resolveAgentTarget`, through the injected agent service; the offline `sf eval validate` falls back to parsing `agents/<id>.agent.yaml`, with `revision` unknown):

| Agent state | Finding |
|---|---|
| no such agent | `eval.agent_not_found` (error) |
| archived | `eval.agent_archived` (error) |
| disabled | `eval.agent_disabled` (**warning**; owner decision 7: eval sessions bypass `enabled`, authors evaluate before enabling) |
| definition has parse issues (`AgentSummary.issues`) | `eval.agent_invalid` (error; the message lists the first issue; plan risk 6) |
| no agent service (store without SQLite) | `eval.agents_unavailable` (error, at run start only; offline validate does not emit it) |

## Defaults for agent targets

Same table as release 1 with these differences (applied when `target.kind` is `agent`):

| Key | Type | Default | Rule |
|---|---|---|---|
| `repeats` | integer | 3 | unchanged, 1-10 (pass^k on conversations is stricter; docs must say so) |
| `concurrency` | integer | **2** | 1-8. Lower than the stage default 4 because a conversation holds a model session for many sequential turns. |
| `max_cost_usd` | number | **1** | `> 0`. Total of agent turns, sub-agent turns, simulator calls and judge calls. Lower than the stage default 2 so a first run cannot spend much; a 6-turn conversation costs about 4-10x a stage case (verification section 11). The wizard writes it explicitly. |
| `user_model` | string | the effective `judge` | A model id `provider/model`. Only meaningful when some case runs `simulated`. Restricted to judge-capable providers (owner decision 4): `eval.simulator_unsupported` otherwise. Rejected on stage targets (`eval.conversation_not_applicable`). |
| `model` | string | none | overrides the agent's model. |

Run-dialog/CLI/API overrides for agents: `repeats`, `judge`, `user_model`, `model`, `max_cost_usd`, `case_ids`, `tags`, `only_failed_from`, `label`, and the **safer-only** overrides `tools` and `approvals` plus the consent flag `allow_real_tools` (below). All recorded in the snapshot.

## Conversation

| Key | Type | Default | Range / rule | Finding on a bad value |
|---|---|---|---|---|
| `mode` | `script` \| `simulated` | `script` | The default for cases; a case overrides it with `input.mode`. | `eval.conversation_invalid` |
| `max_turns` | integer | 8 | 1-30. Number of **user turns** per case. Reaching it is a normal completion (`stop_reason: max_turns`). | `eval.conversation_invalid` |
| `turn_timeout_ms` | integer | 120000 | 5000-600000. One user turn, from sending the message to the agent's reply. | `eval.conversation_invalid` |
| `tools` | `real` \| `read_only` \| `mocked` | `read_only` | See Tool policy. | `eval.conversation_invalid` |
| `approvals` | `deny` \| `auto_approve_read` \| `record_only` | `record_only` | See Approval policy. | `eval.conversation_invalid` |
| `read_only_tools` | string[] | `[]` | ≤ 50 tool grant ids the author declares read-only (plan risk 1). Each is `<server>.<tool>` or `<server>.*` (MCP) or a Stageflow/builtin grant id. | `eval.conversation_invalid` |
| `allow_real_tools` | boolean | `false` | The author's consent to `tools: real`. Only valid with `tools: real`. | see below |

Unknown keys in `conversation` are `eval.unknown_key`. A wrong type or range is `eval.conversation_invalid` with the key named in the message.

Limits: **eval limits replace the agent's own `limits` for eval sessions** (G9). The effective values are `max_turns = conversation.max_turns + 1`, `session_minutes = ceil(max_turns * turn_timeout_ms / 60000) + 5`, `cost_usd = null` (the eval cost cap is enforced by the runner), `always_on = false`, and the session is forced to `capture: full`, `otlp: false`, `evals.groundedness: false`. They are written to the snapshot (`target.limits_override` in [result-schema](evals-result-schema.md#release-2-agents)). The agent file is never edited. Wall-clock per case = `max_turns * turn_timeout_ms + 60 000 ms`.

### Tool policy (`conversation.tools`)

Decision per tool call, in this order (A05 implements it; the table is the contract):

1. **Not granted** to the agent, a forbidden write target (`forbiddenWriteTarget`), an operator-only Stageflow tool, or the always-blocked set -> `denied`. Always blocked under `read_only` and `mocked`: `stageflow.run_eval`, `stageflow.agent_chat`, `stageflow.fire_trigger`, `stageflow.probe_project_mcp` and every `agent:<id>` sub-agent call. Under `real` only `run_eval`, `agent_chat` and `fire_trigger` stay blocked (owner decision 10).
2. If the tool is **ask-first** (the agent's `approvals.ask_first` list, and `bash` always): the approval policy decides (below). Only an approved read call continues to step 3.
3. Tool policy:

| `tools` | read-class tool (builtin `read`/`grep`/`find`/`ls`; Stageflow tool with risk `read`; a tool in `read_only_tools`) | any other tool (write, edit, bash, destructive/external Stageflow tools, unlisted MCP tool, browser) |
|---|---|---|
| `read_only` (default) | `ran` | case `tool_mocks` entry -> `mocked`; else `stubbed` |
| `mocked` | case mock -> `mocked`; else `ran` | case mock -> `mocked`; else `stubbed` |
| `real` | `ran` | `ran` |

`stubbed`: the tool body does not run; the model receives an error-flagged tool result with the text "`<tool>` was not executed in this evaluation." `mocked`: the model receives an error-flagged tool result carrying the canned text (the JSON of `result`, or `error`'s text) because the runtime can only block with a reason (owner decision 8); the docs say mocks are approximate. Every call, whatever the outcome, is recorded in the conversation subject (`policy_outcome`).

`real` requires **both** the file consent `conversation.allow_real_tools: true` and the per-run consent flag (`allow_real_tools` in the API/MCP start body, `--allow-real-tools` on the CLI, a checkbox in the run dialog). Without the file key: `eval.real_tools_not_allowed` (error). With it: `eval.tools_real` (warning, always shown). Without the run flag the start fails `422 EVAL_REAL_TOOLS_NOT_CONFIRMED`. Run-time overrides may only make a policy safer: `tools` order `real` < `read_only` < `mocked`, `approvals` order `auto_approve_read` < `record_only` < `deny`; an escalating override is `422 EVAL_INVALID`.

### Approval policy (`conversation.approvals`)

Applies to ask-first calls only. No approval row is ever created and no turn ever enters `waiting`; nothing reaches the Inbox (G7).

| `approvals` | Ask-first call that is read-class | Ask-first call that is not read-class |
|---|---|---|
| `record_only` (default) | `would_ask_first` | `would_ask_first` |
| `deny` | `denied` | `denied` |
| `auto_approve_read` | continues to the tool policy (can be `ran`) | `would_ask_first` |

Both `would_ask_first` and `denied` answer the model with "Approval for `<tool>` was not granted in this evaluation. Continue without it." (denied by policy, never by a person). `would_ask_first` is the only outcome a grader can assert as "the agent tried something that needs approval" (`tool_calls.must_ask_first`).

## Graders for agent targets

New common rule: each grader type has a **subject kind** it applies to. A grader that cannot apply to the eval's target is a validation **error** `eval.grader_not_applicable` (G10), reported at validation and at run start, never first at run time. If one is reached at run time anyway it grades `status: error`, `error_code: EVAL_GRADER_NOT_APPLICABLE`.

| Grader type | Target `stage` (envelope subject) | Target `agent` (conversation subject) |
|---|---|---|
| `schema` | applies | `eval.grader_not_applicable` |
| `field` | applies | applies (paths below) |
| `reference` | applies | applies (default `path: final_reply`) |
| `rubric` | applies | applies (judge reads the bounded transcript) |
| `code` | applies | applies (`output` is the conversation subject) |
| `tool_calls` | `eval.grader_not_applicable` | applies |
| `conversation_check` | `eval.grader_not_applicable` | applies |
| `goal_reached` | `eval.grader_not_applicable` | applies |
| `command` | not in release 1 or 2 (`eval.grader_type_unsupported`) | same |
| `groundedness` | no story in release 2 (`eval.grader_type_unsupported`) | same |

`eval.grader_type_unsupported` now lists `schema field reference rubric code tool_calls conversation_check goal_reached` (the new three are valid types for every target; the matrix decides applicability).

### Path root for the conversation subject

`field.checks[].path` and `reference.path` evaluate against the **conversation subject object itself** (the [subject JSON](evals-result-schema.md#conversation-subject)), the same way release 1 evaluates against the envelope object `{ status, summary, artifacts, payload }`. There is no `output.` prefix in a path (the plan's `output.final_reply` is the `code` grader's variable name). Same syntax (dot keys, `[n]`, `[*]`) and the same `op` table.

| Path | Meaning |
|---|---|
| `final_reply` | last assistant message text |
| `turns` | number of user turns |
| `stop_reason` | see subject |
| `messages[*].text`, `messages[0].role` | transcript |
| `tool_calls[*].name`, `tool_calls[*].policy_outcome`, `tool_calls[0].args.invoice_id` | recorded tool calls |
| `usage.cost_usd` | numbers |

`reference` defaults: `path: final_reply` for agent targets (`payload` stays the default for stage targets; the write path elides a default only when it equals the target's default). `expected` is a path into the case, for example `expected.outcome`.

### `tool_calls`

| Key | Type | Rule |
|---|---|---|
| `must_call` | string[] | Each name must appear in `tool_calls[].name`. A trailing `.*` matches a server prefix. Default when absent: the case's `expected.tools`. `[]` opts out. |
| `must_not_call` | string[] | None may appear. Default when absent: the case's `expected.forbidden_tools`. `[]` opts out. |
| `must_ask_first` | string[] | Each name must appear with `policy_outcome: would_ask_first`. No default. |
| `max_calls` | integer 0-200 | `tool_calls.length` must be ≤ this. |
| `args` | array (≤ 20) of `{ tool, path, op, value? }` | `path` is evaluated against each call's `args` object; `op` from the field op table. **Every call to `tool` must satisfy it; no call to the tool passes vacuously** (combine with `must_call` for "must be called"). |

A call **counts as called whatever its outcome** (an attempted `billing.refund` that was stubbed violates `must_not_call`). Score 1 if every rule holds, else 0; `must_pass`, `weight` as usual. `details.checks`: `[{ rule, passed, found }]`. When no rule resolves for a case (no keys and no `expected` values), the grade is an error `EVAL_CASE_MISSING_EXPECTED`. Validation: at least one of the five keys, or the author relies on case defaults (then `eval.cases_missing_expected` warns when some cases lack `expected.tools`/`forbidden_tools`). Names that the agent is not granted give `eval.tool_not_granted` (warning; for `must_call` it can never pass).

### `conversation_check`

| Key | Type | Rule |
|---|---|---|
| `max_turns` | integer 1-100 | `turns` ≤ value |
| `max_agent_questions_per_turn` | integer 0-10 | In every turn, the assistant text of that turn contains at most this many questions. A question is a `?` followed by whitespace or end of text, outside code fences and URLs. |
| `final_reply` | array (≤ 10) of `{ op, value? }` | Each op from the field table is applied to `final_reply` (a string). All must hold. |

At least one key is required (`eval.grader_invalid`). Deterministic, 1 or 0. `details.checks` as for `field`.

### `goal_reached`

| Key | Type | Rule |
|---|---|---|
| `judge` | string | Optional model id overriding `defaults.judge`; same provider restriction as `rubric`. |
| `guidance` | string | Optional, ≤ 2,000 chars, extra instructions for the judge. |

Always `pass_fail` (a `scale` key is `eval.grader_invalid`). The judge reads the bounded transcript and the case goal (`input.goal`, else `expected.outcome`) and answers whether the agent achieved it; it does not trust the simulator's stop marker. A case with neither goal nor outcome grades `error` `EVAL_CASE_MISSING_EXPECTED`; validation warns with `eval.cases_missing_goal`. It counts as a rubric grader for `eval.judge_missing`, `eval.judge_same_as_stage` (reused code; the message names the agent), estimates and the Graders tab.

### Existing types on a conversation

- `rubric`: the judge sees the rubric, examples, the case `input` (scenario) and `expected`, and the **bounded rendered transcript** (turn cap, per-message cap, tool results truncated: limits in [engine-interface](evals-engine-interface.md#release-2-agents)). It uses the conversation prompt variant (`CONVERSATION_RUBRIC_PROMPT_VERSION`). `examples[].output` are transcript snippets.
- `code`: the function receives `(output, testCase, context)` where `output` is the (frozen, redacted, size-capped) conversation subject. Same trust level and 5 s timeout.

## Validation findings added in release 2

Same shape as release 1. Codes (exhaustive for release 2):

| Code | Severity | When |
|---|---|---|
| `eval.agent_not_found` | error | see Agent target |
| `eval.agent_archived` | error | |
| `eval.agent_disabled` | warning | |
| `eval.agent_invalid` | error | agent definition has parse issues |
| `eval.agents_unavailable` | error | run start with no agent service |
| `eval.conversation_invalid` | error | bad `conversation` value (names key and rule) |
| `eval.conversation_not_applicable` | error | `conversation` or `defaults.user_model` on a stage target |
| `eval.task_not_applicable` | error | `task` on an agent target |
| `eval.grader_not_applicable` | error | grader type x target kind per the matrix |
| `eval.tool_not_granted` | warning | a name in `tool_calls` / `read_only_tools` / a case `tool_mocks` key is not a tool the agent is granted |
| `eval.tools_real` | warning | `tools: real` (always shown; text: "Real tools can change files and call services from this machine.") |
| `eval.real_tools_not_allowed` | error | `tools: real` without `allow_real_tools: true` |
| `eval.tools_unstubbed_list` | warning | `read_only` and some granted tools classify as not read-only (names the first five; "These are stubbed and recorded, not executed") |
| `eval.tools_mocked_no_mocks` | warning | `tools: mocked` and no case has `tool_mocks` |
| `eval.user_model_missing` | error | some case runs `simulated` and neither `user_model` nor `judge` is set |
| `eval.simulator_unsupported` | error | `user_model` provider is not judge-capable (or its key is not exportable) |
| `eval.simulator_unknown_model` | warning | `user_model` not in the model catalog |
| `eval.simulator_same_as_agent` | warning | effective `user_model` equals the agent's effective model |
| `eval.cases_missing_goal` | warning | `goal_reached` and some cases have no `input.goal` or `expected.outcome` |
| `eval.cases_skipped` / `eval.no_valid_cases` | warning / error | reused for scenarios that fail the dataset scenario check |

`eval.target_kind_unsupported` now means a kind that is neither `stage` nor `agent`. `eval.judge_missing` and `eval.judge_same_as_stage` are reused. `eval.unknown_key` covers unknown `conversation` keys. Stage-only findings (`eval.schema_grader_without_output_schema`, `eval.stage_has_gates`, `eval.stage_needs_checkout`) are never emitted for agent targets.

## Writing the file (agents)

A10 writes agent evals through the existing write path (`writeEval.ts`): key order above; `conversation` is **always written explicitly** when created from the form (`mode`, `max_turns`, `turn_timeout_ms`, `tools`, `approvals`) together with `defaults.repeats`, `pass_threshold`, `max_cost_usd`, `concurrency` so a reader sees them; `read_only_tools` and `allow_real_tools` only when non-default. Flow style for `tool_calls.args` and `conversation_check.final_reply` items. Comment-preserving edits as in release 1.
