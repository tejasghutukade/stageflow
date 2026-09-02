---
name: stageflow-run
description: >-
  Starts a catalog pipeline from the harness, reports progress, and answers
  every HITL gate on the host native question UI when it can, otherwise in
  this chat. Triggers: run a pipeline, start <pipeline>, check on my run,
  answer the pending question.
compatibility: Requires the sf CLI on PATH. An MCP host (sf ui or sf mcp) is optional.
disable-model-invocation: true
---

# Stageflow run

Start a catalog pipeline, present HITL on the host native question UI when it can, and report the outcome. Author and session-capture own catalog YAML; this job owns the run and any throwaway `*.task.yaml`.

Talking jobs cite [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md). Probe with [`../stageflow/scripts/detect-host.mjs`](../stageflow/scripts/detect-host.mjs) only. Do not write a second probe.

MCP tool shapes: [`docs/mcp.md`](../../docs/mcp.md). CLI flags and exit codes: [`docs/cli-reference.md`](../../docs/cli-reference.md). Direct tool calls: [`references/mcp-call.md`](references/mcp-call.md). Selection: [`references/task-and-pipeline-selection.md`](references/task-and-pipeline-selection.md). Gate presentation: [`references/native-question-ui.md`](references/native-question-ui.md).

## Preconditions

Run `sf --version`. **Done when** it prints a version. If `sf` is missing, stop and name `stageflow-setup`.

## Probe

```
node ../stageflow/scripts/detect-host.mjs
node ../stageflow/scripts/detect-host.mjs --base-url http://127.0.0.1:3847
```

| stdout | path |
|---|---|
| `up <baseUrl>` | [MCP path](#mcp-path) |
| `down <baseUrl>` | [CLI path](#cli-path) |

**Done when** you have `up` or `down` and the base URL.

## Select

Read [`references/task-and-pipeline-selection.md`](references/task-and-pipeline-selection.md). Follow it until you have a pipeline filesystem path and a task (catalog path, MCP inline object, or CLI throwaway file).

If this chat already has a `runId` and the request is check, answer, or continue: skip start. Host up → [Wait](#wait). Host down → [CLI wait](#cli-wait).

**Done when** the target is named, or a live `runId` is in hand.

## MCP tools

Prefer this harness's native Stageflow MCP tools when their names are already in the tool list. When they are not, call [`scripts/mcp-call.mjs`](scripts/mcp-call.mjs) — see [`references/mcp-call.md`](references/mcp-call.md). Use `--stateless` only when the **user** started the host with `--mcp-stateless`. Do not start `sf mcp` from this skill.

Call only these Stageflow MCP tools: `list_pipelines`, `list_tasks`, `start_run`, `get_run`, `wait_run`, `list_waiting`, `answer_gate`, `get_health`. Host question tools already in this harness's tool list (`AskQuestion`, `AskUserQuestion`, `ask_user`) are for [Gate](#gate) presentation, not Stageflow MCP.

## MCP path

### Start

`start_run` with `pipeline` plus exactly one of `task_path` or inline `task`.

| result | next |
|---|---|
| `{ "runId" }` | [Wait](#wait) |
| `busy_capacity` / `busy_checkout` | [Report](#report) the included fields. Stop. Do not retry. |
| other `isError` | [Report](#report) the payload. Stop. |

**Done when** you have a `runId`, or a busy/error report is printed.

### Wait

`wait_run` with `{ "runId", "until": "any" }`. A shorter `timeout_ms` is fine when the harness tool timeout is tight.

| `reason` | next |
|---|---|
| `waiting` or `already` with a waiting snapshot | [Gate](#gate) |
| `terminal` | [Report](#report) |
| `timeout` | call `wait_run` again |
| `isError` with `code: "aborted"` | [Report](#report): the run continues, resumable later. Stop. |
| other `isError` | [Report](#report) the payload. Stop. |

**Done when** the run is waiting (hand to Gate), terminal, aborted, or a hard error is printed.

### Gate

Read [`references/native-question-ui.md`](references/native-question-ui.md) before presenting a pending prompt.

1. `list_waiting` with `{ "runId" }`.
2. Print the pending prompt text **verbatim** (and artifacts / sub-questions when present).
3. Present the decision as that reference directs:
   - If a host question tool is already in this harness's tool list and the gate is representable, invoke that picker. For `multi_question`, one picker call with one question per sub-item when **every** sub-question is representable, then one `answer_gate`; otherwise the **whole** gate in this chat.
   - Otherwise collect the reply in this chat.
4. Map the reply to the prompt `kind` (picker Accept/Reject → `accept`/`reject`):

| kind | `answer` |
|---|---|
| `free_text` | `{ "promptId", "kind": "free_text", "text" }` |
| `confirm` | `{ "promptId", "kind": "confirm", "decision": "accept" \| "reject" }` |
| `artifact_backed` | `{ "promptId", "kind": "artifact_backed", "decision": "accept" \| "reject" }` |
| `multi_question` | `{ "promptId", "kind": "multi_question", "answers": { "<id>": { "kind", "text" \| "decision" } } }` |

`promptId` is `pending_prompt.id` or `waiting_prompt_id`. Map yes/y/accept/approve/Accept to `accept`; no/n/reject/deny/Reject to `reject`. Each `multi_question` sub-answer keeps that sub's `kind` (`confirm` → `decision`, `free_text` → `text`). Collect every sub-answer before `answer_gate`.

5. `answer_gate` with `{ "runId", "stageId", "answer" }`.
6. Return to [Wait](#wait).

**Done when** `answer_gate` returns `{ "ok": true }` and Wait is re-entered. On `isError` (400 / 404 / 409), print the payload and collect a corrected reply the same way (picker if still representable; otherwise this chat).

## CLI path

Discovery without a host: read `stageflow.yaml` catalog roots as in [`references/task-and-pipeline-selection.md`](references/task-and-pipeline-selection.md).

```
sf run --task <path> --pipeline <path> --json
```

Add `--checkout`, `--git-sha`, `--ci-pr-url`, `--ci-job-url`, `--operator-cwd`, or `--operator-agent-dir` only when the human supplied them. Always pass `--json`. Omit `--include stages` unless the human asked for a stage projection — and then only together with `--json`.

Parse the single JSON document.

| exit | `outcome` | next |
|---|---|
| `0` | `succeeded` | [Report](#report) |
| `1` | `failed` | [Report](#report) `reason` verbatim |
| `1` | `busy` | [Report](#report) `busy_capacity` / `busy_checkout` and the included fields. Stop. |
| `2` | `waiting` | [CLI wait](#cli-wait) with this `runId` / `runDir` |

**Done when** the outcome is reported, or a waiting exit has handed `runId` to CLI wait.

## CLI wait

Host down after `sf run` exit `2`, or when this chat already has a `runId` and the host is down. Do not start `sf mcp`. Presentation follows [`references/native-question-ui.md`](references/native-question-ui.md). Submit with `sf runs answer --json`.

1. Probe again with [`../stageflow/scripts/detect-host.mjs`](../stageflow/scripts/detect-host.mjs) (the host may have appeared). Probe before each `sf runs answer`.
2. **Up:** use that host — native tools if present, otherwise `mcp-call.mjs` (omit `--stateless` unless the user started the host with `--mcp-stateless`). Continue at [Gate](#gate).
3. **Down:**

```
sf runs waiting --run <runId> --json
```

Print the pending prompt **verbatim**. Present it as native-question-ui directs (picker or chat). Map the reply with the [Gate](#gate) kind table.

```
sf runs answer --run <runId> --stage <stageId> --answer '<json>' --json
```

Success is `{ "ok": true }` exit `0` even if the run parks again. Do not treat answer as terminal.

```
sf runs wait --run <runId> --json --until any
```

A shorter `--timeout-ms` is fine when the harness timeout is tight. Default `60000`, max `240000`. Branch on JSON `reason`, not wait exit `0`:

| `reason` | next |
|---|---|
| `waiting` or `already` with a waiting snapshot | `sf runs waiting` then answer |
| `terminal` | [Report](#report) |
| `timeout` | call `sf runs wait` again |

Wait abort (exit `130`, `{ "error", "code": "aborted" }`) → [Report](#report): the run continues, resumable later. Stop. Do not reuse `sf run` exit `2` for wait.

4. If `sf runs answer` refuses because the host came up, continue that gate via MCP [Gate](#gate). Do not dual-write.

If this chat ends before terminal, say the run stays in `.stageflow/` and to continue by re-invoking this skill (or starting a host and using MCP).

**Done when** the run is terminal, aborted, or a hard error is printed.

## Report

Print one shape on every path:

1. Current or last-known stage (MCP live snapshot, or "start/finish only" on a CLI-only stretch).
2. Waiting prompt text verbatim when the run is parked.
3. Outcome: `succeeded`, `failed`, `waiting`, or `busy`.
4. Run id.
5. Run folder (`runDir` / `.stageflow/`).

MCP `get_run` / `wait_run` and `sf runs wait` / `sf runs show` `--json` carry live stage state. `sf run --json` reports start and finish only — say that in chat when the CLI path ran without a later wait/show. A succeeded report names id and folder and does not keep waiting language. A failure names `reason` in this same shape.

**Done when** that five-part report is printed.

## Non-goals

This job starts, watches, and answers runs. It does not require `sf ui`. The operator console is not the answer path. It does not register or invent an MCP tool. It does not start `sf mcp`. It does not retry, abandon, or rerun stages.
