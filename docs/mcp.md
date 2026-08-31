---
layout: default
title: Mcp
---

# MCP

When `sf ui` is running, Stageflow serves a **Streamable HTTP** MCP endpoint at:

```
http://127.0.0.1:3847/mcp
```

The URL is printed on boot alongside the operator console link. Point Cursor or another MCP client at this URL while the server process is alive.

MCP tools resolve the **project git root** for catalog browse and the **`<git-root>/.stageflow/`** run store — the same semantics as CLI commands, not the shell cwd where you started `sf ui`.

Implementation: `src/mcp/tools.ts`.

> **Breaking change (pipeline-owned catalog):** `list_pipelines` returns manifest filesystem path listings (objects with `path`, `id`, …), not bare pipeline ids. `start_run` requires a `pipeline` path and exactly one of `task_path` or inline `task`. Update MCP clients that passed ids like `"hello"`.

## Tools

### `list_pipelines`

List manifest-declared pipeline paths from the project catalog.

**Input:** `{}`

**Output:**

```json
{
  "pipelines": [
    {
      "path": "examples/hello-world/hello.pipeline.yaml",
      "id": "hello"
    },
    {
      "path": "examples/plan-review/plan-review.pipeline.yaml",
      "id": "plan-review"
    }
  ]
}
```

Paths are relative to the project git root (as declared in `stageflow.yaml`). Listing objects may include additional catalog fields (for example stage summaries) depending on browse.

### `list_tasks`

List manifest-declared task paths from the project catalog.

**Input:** `{}`

**Output:**

```json
{
  "tasks": [
    {
      "path": "examples/hello-world/my-task.task.yaml",
      "id": "my-task"
    },
    {
      "path": "examples/plan-review/my-task.task.yaml",
      "id": "my-task"
    }
  ]
}
```

### `list_runs`

List known pipeline runs from the SQLite store.

**Input:**

```json
{
  "status": "running",
  "since": "2026-08-31T00:00:00.000Z",
  "pipeline": "docs-only"
}
```

All fields optional. Omit filters for all runs, newest first.

| Field | Meaning |
|-------|---------|
| `status` | `created` \| `running` \| `succeeded` \| `failed` |
| `since` | ISO timestamp; keep runs with `created_at >= since` |
| `pipeline` | Match `pipeline_id` or `pipeline_path` |

**Output:** `{ "runs": [ … ] }` (`RunSummary` rows)

### `list_waiting`

List stages currently in `waiting_for_input`.

**Input:** `{ "runId": "…" }` — `runId` optional; omit to scan all runs.

**Output:** `{ "waiting": [ { "runId", "stageId", "waiting_kind?", "waiting_summary?", "waiting_prompt_id?", "pending_prompt?", "waiting_artifacts?", "waiting_questions?" } ] }`

### `answer_gate`

Deliver an operator answer for a waiting stage (same semantics as `POST /api/runs/:id/stages/:stageId/answer`).

**Input:**

```json
{
  "runId": "…",
  "stageId": "clarify",
  "answer": {
    "promptId": "prompt-1",
    "kind": "free_text",
    "text": "payments"
  }
}
```

`answer` must match `AskOperatorAnswer` for the pending prompt kind (`free_text`, `confirm`, `artifact_backed`, `multi_question`).

**Success:** `{ "ok": true }`

**Errors (`isError: true`):** `400` malformed/mismatched answer; `404` unknown run/stage; `409` stage not waiting.

### `get_health`

Server health and soft-max run capacity.

**Input:** `{}`

**Output:**

```json
{
  "ok": true,
  "activeRunIds": [],
  "activeCount": 0,
  "maxConcurrent": 3,
  "slotsAvailable": 3,
  "activeStageProcesses": 0,
  "maxActiveStageProcesses": null
}
```

Default `maxConcurrent` is 3 (override via `STAGEFLOW_MAX_CONCURRENT_RUNS` or console settings). `maxActiveStageProcesses` is `null` when unlimited.

Start runs until `slotsAvailable` is `0`; then wait for a run to finish or raise `STAGEFLOW_MAX_CONCURRENT_RUNS`.

### `start_run`

Start a pipeline run using a **filesystem pipeline path** and either a catalog task file or an inline task object.

**Input (task file):**

```json
{
  "pipeline": "pipelines/hello.pipeline.yaml",
  "task_path": "tasks/hello.task.yaml"
}
```

**Input (inline task):**

```json
{
  "pipeline": "pipelines/hello.pipeline.yaml",
  "task": {
    "id": "inline-task",
    "goal": "…",
    "context": "optional",
    "constraints": "optional",
    "checkout": "optional"
  }
}
```

Exactly one of `task_path` or `task` is required.

**Success output:** `{ "runId": "…" }`

**Error output** (`isError: true`):

| Reason | Code | Meaning |
|--------|------|---------|
| Capacity full | `busy_capacity` | Includes `activeCount`, `maxConcurrent`, `activeRunIds` |
| Checkout lease conflict | `busy_checkout` | Includes `conflictingRunId`, `conflictingCheckout` |

Task schema matches `TaskFile` (`id`, `goal`, optional `context`, `constraints`, `checkout`).

### `get_run`

Poll run status without loading the full event stream.

**Input:** `{ "runId": "…" }`

**Output:** Projected run detail — status, stage statuses, envelope summary/payload/artifact paths (**no events**). When a stage is waiting, includes run-level `waiting_*` fields and per-stage `pending_prompt`. When present on the run record, includes `pipeline_path` and `task_path`.

Use `list_stage_events` / `get_envelope` for timelines and full envelopes.

Returns `404`-style error JSON when the run is not found.

### `list_stage_events`

List persisted stage log events (lifecycle/activity). Optional `attempt` scopes to one attempt.

**Input:** `{ "runId", "stageId", "attempt?" }`

**Output:** `{ "runId", "stageId", "attempt?", "events": [ … ] }`

### `get_envelope`

Read the full `StageEnvelope` for a stage (latest attempt).

**Input:** `{ "runId", "stageId" }`

**Output:** `{ "runId", "stageId", "envelope": { … } }`

Returns `404` when the run, stage, or envelope is missing.

### `read_artifact`

Read a text artifact from a run workspace.

**Input:**

```json
{
  "runId": "…",
  "path": "stages/clarify/attempts/1/artifacts/plan.md"
}
```

**Output:** `{ "runId", "path", "content" }`

Path must be contained under the run workspace. Returns `404` for missing run or artifact.

Note: `stages/<stageId>/attempts/…` paths are **run workspace** layout, not catalog directories. After clonable fan-out, `stageId` is the instance id (`author-diagrams~2`); run-once stays the catalog id. See [YAML catalog — instance ids](yaml-catalog.md#clonable-instance-ids).

### `validate`

Validate the project catalog, a pipeline path, or a task path (same authority as `sf validate`).

**Input:** `{ "pipeline?", "task?", "strict?" }`

Scope is inferred: `pipeline` set → pipeline scope; else `task` set → task scope; else full catalog.

**Output:** `ValidationResult` — `{ "scope", "ok", "summary": { "errors", "warnings" }, "findings": [ … ] }` (findings include severity, code, path, message, category, and optional pipeline/stage ids).

### `describe_pipeline`

Describe a pipeline DAG from a filesystem pipeline path (same locator style as `start_run`).

**Input:** `{ "pipeline": "pipelines/clone-fanout-mix.pipeline.yaml" }`

**Output:**

```json
{
  "id": "clone-fanout-mix",
  "path": "…",
  "stages": [
    {
      "id": "clarify",
      "needs": null,
      "fork": { "select": "subset", "allow_none": false },
      "gate_kinds": ["free_text"]
    },
    {
      "id": "design-doc",
      "needs": "clarify",
      "clonable": true,
      "clone_cap": 5
    }
  ]
}
```

### `retry_stage`

Retry a **failed** stage (same as HTTP `POST .../retry`).

**Input:** `{ "runId", "stageId" }`

**Success:** `{ "runId", "stageId", "attemptIndex" }`

Waiting stages are not retryable (`409`, often `code: "hitl_not_retriable"`) — use `answer_gate` instead.

### `abandon_stage`

Abandon a **running** stage (marks it failed/interrupted). Does **not** dismiss HITL waiting gates (`409` if waiting) — answer those with `answer_gate`.

**Input:** `{ "runId", "stageId" }`

**Success:** `{ "ok": true, "runId", "stageId" }`

There is **no** run-level cancel/abort MCP tool.

### `rerun`

Start a new run from a completed or failed run’s pipeline/task locators.

**Input:** `{ "runId": "…" }`

**Success:** `{ "runId": "…" }` (new run id)

## Cursor configuration

Add an MCP server entry pointing at the Streamable HTTP URL while `sf ui` runs, for example:

```json
{
  "mcpServers": {
    "stageflow": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

Exact config shape depends on your MCP client version. Session IDs are not required for the current **stateless** Streamable HTTP transport.

## Limitations

- MCP requires `sf ui` — there is no standalone `sf mcp` command
- No run-level cancel/abort tool (abandon is per running stage only)
- No `wait_run` / long-poll or push notifications (deferred)
- No MCP resources / stateful sessions (deferred)
- Default `get_run` stays lean (no stage event streams); use `list_stage_events` / `get_envelope` for detail
- Tools return JSON text content blocks

## See also

- [Operator console](operator-console.md) — starts MCP alongside the UI
- [HITL](hitl.md) — gate kinds and answer shapes
- [CLI reference](cli-reference.md) — `sf ui`, `sf validate`
- [CI / headless](ci.md) — MCP not used in CI jobs
- [Envelopes](envelopes.md) — artifact paths returned by `get_run` / `get_envelope`
