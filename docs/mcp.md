---
layout: default
title: Mcp
---

# MCP

Stageflow serves **Streamable HTTP** MCP with **stateful sessions as the product default**. Host it via either:

- `sf ui` — operator console + MCP
- `sf mcp` — MCP-only (no browser, no console assets)

Default endpoint:

```
http://127.0.0.1:3847/mcp
```

The URL is printed on boot. Point Cursor or another MCP client at this URL while the host process is alive.

## Sessions (how MCP works)

1. Client `POST /mcp` with an `initialize` request (no session header).
2. Server responds with an `Mcp-Session-Id` header.
3. Client opens `GET /mcp` with that header for the SSE listen channel (server→client notifications).
4. Subsequent tool / resource calls reuse the same session header on `POST /mcp`.
5. `DELETE /mcp` with the session header closes the session.

Sessions enable run **resource subscribe** and `notifications/resources/updated`. Without a GET listen stream, tools still work on the session; push updates will not be delivered.

`createHttpHost` applies `localhostHostValidation` and `localhostOriginValidation` from `@modelcontextprotocol/node` on `/mcp`. Non-localhost `Origin` / `Host` is rejected. Point clients at `http://127.0.0.1:3847/mcp` (not a LAN hostname).

### Stateless escape hatch (test/debug)

For clients or harnesses that must avoid session headers:

```bash
sf mcp --mcp-stateless
# or
STAGEFLOW_MCP_STATELESS=1 sf mcp
```

Same flag/env applies to `sf ui`. Stateless mode uses per-request create/teardown (`sessionIdGenerator: undefined`). Tier 1 tools and Tier 2 `wait_run` work in both modes. Resource **subscribe/notify** requires session mode + GET SSE listen.

## `sf mcp` vs `sf ui`

| Host | Serves | Browser |
|------|--------|---------|
| `sf ui` | Console REST/static + `/mcp` | Opens by default |
| `sf mcp` | `/mcp` + minimal `GET /api/health` | No |

Both use the same git-root / `.stageflow/` store semantics and default port `3847`. Run **either** `sf ui` **or** `sf mcp` for a given project root — not both (one writer process; the second bind on the same port fails). Different ports against the same store with two managers is unsupported.

MCP tools resolve the **project git root** for catalog browse and the **`<git-root>/.stageflow/`** run store — the same semantics as CLI commands, not the shell cwd where you started the host.

Implementation: `src/mcp/tools.ts`, `src/mcp/resources.ts`, `src/mcp/server.ts`.

> **Breaking change (pipeline-owned catalog):** `list_pipelines` returns manifest filesystem path listings (objects with `path`, `id`, …), not bare pipeline ids. `start_run` requires a `pipeline` path and exactly one of `task_path` or inline `task`. Update MCP clients that passed ids like `"hello"`.

## Resources

### `stageflow://runs/{runId}`

Runs-only resource template. Catalog discovery stays on `list_pipelines` / `list_tasks` tools — there is **no** `stageflow://catalog/pipelines` resource in v1.

| Operation | Notes |
|-----------|-------|
| `resources/list` | Enumerates known runs as `stageflow://runs/{runId}` |
| `resources/read` | JSON text of the lean `get_run` projection (no stage events) |
| `resources/subscribe` | Session mode + GET SSE; receive `notifications/resources/updated` |

**When `updated` fires:** run created; run `status` changes; waiting fields appear or clear (HITL park / resume). Not on every stage activity log line.

### Dual observation paths (permanent)

| Path | Mechanism |
|------|-----------|
| `wait_run` | Poll-inside-wait tool; works without sessions / without the change bus |
| Resource subscribe | Push via GET SSE; complementary, not a replacement for `wait_run` |

Compose either way:

```
start_run → wait_run (until waiting/any) → answer_gate → wait_run (until terminal)
```

```
start_run → resources/subscribe(stageflow://runs/{runId}) → on updated, get_run / answer_gate
```

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
      "id": "hello",
      "stages": [
        { "id": "research", "uses_path": "examples/hello-world/research.yaml" }
      ]
    },
    {
      "path": "examples/plan-review/plan-review.pipeline.yaml",
      "id": "plan-review",
      "stages": [{ "id": "plan-review" }]
    }
  ]
}
```

Paths are relative to the project git root (as declared in `stageflow.yaml`). Each listing always includes `stages: PipelineStageListing[]` (`id`, optional `gate_kinds`, `uses_path`, `inline`).

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

Exactly one of `task_path` or `task` is required. Schema is only `pipeline` plus `task_path` or `task` — no skip-gates, no CI identity flags, and no `--checkout` override (checkout comes from `task.checkout` only). HITL always parks.

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

Use `list_stage_events`, `get_envelope`, or `get_stage_verification` for detailed
stage records.

Returns `404`-style error JSON when the run is not found.

### `wait_run`

Long-poll until a run reaches a HITL waiting point and/or a terminal status, or until `timeout_ms` elapses. Holds one MCP `tools/call` HTTP request. Uses **poll-inside-wait** against the store (ignores the resource change bus). Works in session mode and with `--mcp-stateless`.

**Input:**

```json
{
  "runId": "…",
  "timeout_ms": 60000,
  "until": "any"
}
```

| Field | Meaning |
|-------|---------|
| `runId` | Required |
| `timeout_ms` | Optional wait budget in ms. Default `60000`. Must be in `(0, 240000]`. |
| `until` | Optional wake predicate: `"any"` (default), `"waiting"`, or `"terminal"` |

**Wake predicates**

| `until` | Wakes when |
|---------|------------|
| `waiting` | Any stage is `waiting_for_input` / non-empty `waiting_stage_ids` (run `status` stays `"running"` during HITL). A terminal run also ends the wait. |
| `terminal` | Run `status` is `succeeded` or `failed` |
| `any` | Waiting **or** terminal |

Already-satisfied predicates return immediately with `reason: "already"` (not an error).

**Success output:**

```json
{
  "reason": "waiting",
  "elapsed_ms": 1234,
  "until": "any",
  "run": { }
}
```

`reason` is one of `waiting` | `terminal` | `timeout` | `already`. Nested `run` matches lean `get_run` (no events; includes `waiting_*` / `pending_prompt` when waiting).

**Timeout is success:** when the budget elapses without a matching wake, the tool returns `reason: "timeout"` with the latest snapshot and `isError: false`.

**Abort ≠ cancel run:** cancelling the MCP request / aborting the handler signal ends only the wait (`isError` with `code: "aborted"`). The pipeline run continues. There is still no run-level cancel tool.

**Optional progress:** if the client supplies `_meta.progressToken` on `tools/call`, the server may emit sparse `notifications/progress` during the poll loop. Progress is never required for correctness. Many clients default tool timeouts to ~60s; only clients that honor progress and `resetTimeoutOnProgress` benefit. Cursor behavior is unverified — pass a shorter `timeout_ms` when unsure.

**Node `requestTimeout`:** both `sf ui` and `sf mcp` disable Node’s default 300s `requestTimeout` so a max `timeout_ms` of 240s is not cut off by the socket layer.

**Compose with HITL**

```
start_run → wait_run (until waiting/any)
         → answer_gate
         → wait_run (until terminal)
```

Prefer `wait_run` over chatty `get_run` loops when waiting for the next interaction point. Prefer resource subscribe when the client already holds a session GET listen stream. A coding-agent host may present the pending prompt on its native question UI; the submit path is still `answer_gate`.

**Errors (`isError: true`):** `404` unknown run; `400` invalid `timeout_ms`; `code: "aborted"` when the client aborts the wait.

### `list_stage_events`

List persisted stage log events (lifecycle/activity). Optional `attempt` scopes to one attempt.

**Input:** `{ "runId", "stageId", "attempt?" }`

**Output:** `{ "runId", "stageId", "attempt?", "events": [ … ] }`

### `get_stage_verification`

Read the completion-check history for one stage. Each attempt contains its check
statuses and persisted evidence, including command output where configured.

**Input:** `{ "runId", "stageId" }`

**Output:** `{ "run_id", "stage_id", "attempts": [{ "attempt", "status", "checks" }] }`

Use this to understand an automatic repair: the failed attempt and the successful
repair are returned as separate records. It returns `404` when the run or stage is
unknown.

### `recover_manual_stage`

Explicitly authorize a new attempt after a `recovery.mode: manual` completion
verification failure. Optional `guidance` (up to 4,000 characters) is persisted and
supplied to the agent along with the failed-check capsule.

**Input:** `{ "runId", "stageId", "guidance?" }`

### `stop_manual_recovery`

Record the operator decision to leave a manual-recovery stage failed. It cannot be
recovered again in that run.

**Input:** `{ "runId", "stageId" }`

### `get_envelope`

Read the full `StageEnvelope` for a stage (latest attempt).

**Input:** `{ "runId", "stageId" }`

**Output:** `{ "runId", "stageId", "envelope": { … } }`

Returns `404` when the run, stage, or envelope is missing. MCP does **not** synthesize an envelope for fork-skipped stages. CLI `envelope get` synthesizes `{ status: "skipped", summary: "stage was fork-skipped", artifacts: [], fork_choice: null }` when the stage is skipped and no envelope is stored.

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

UTF-8 text only. Path must be relative, with no `..`, and contained under the run workspace. Denied: any `.pi-agent` path segment, and files named `auth.json` (same rules as CLI `sf artifact read`). Returns `404` for missing run or artifact.

Note: `stages/<stageId>/attempts/…` paths are **run workspace** layout, not catalog directories. After clonable fan-out, `stageId` is the instance id (`author-diagrams~2`); run-once stays the catalog id. See [YAML catalog — instance ids](yaml-catalog.md#clonable-instance-ids).

### `validate`

Validate the project catalog, a pipeline path, or a task path (same authority as `sf validate`).

**Input:** `{ "pipeline?", "task?", "strict?" }`

Scope is inferred: `pipeline` set → pipeline scope; else `task` set → task scope; else full catalog (pipelines **and** tasks). If both `pipeline` and `task` are set, **pipeline wins** (CLI `sf validate` rejects both).

**Output:** `ValidationResult` — `{ "scope", "ok", "summary": { "errors", "warnings" }, "findings": [ … ] }` (findings include severity, code, `path`, message, category, and optional pipeline/stage ids). MCP keeps `path`; CLI `--json` remaps that field to `file`.

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

Start a new run from a stored run’s `pipeline_path` plus task YAML (`RunManager.rerun`). Does **not** require the source run to be completed or failed (unlike CLI `sf export-run`, which requires `succeeded` or `failed`).

**Input:** `{ "runId": "…" }`

**Success:** `{ "runId": "…" }` (new run id)

Fails if catalog locators are missing (`400` / `404`). May return the same busy codes as `start_run` (`busy_capacity`, `busy_checkout`).

## Cursor configuration

Add an MCP server entry pointing at the Streamable HTTP URL while `sf ui` or `sf mcp` runs, for example:

```json
{
  "mcpServers": {
    "stageflow": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

Exact config shape depends on your MCP client version. Prefer session-capable Streamable HTTP clients. Use `--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` only for test/debug clients that cannot send session headers. The host rejects non-localhost `Origin` / `Host`, so use `127.0.0.1` (or `localhost`) in the URL.

## Limitations

- No run-level cancel/abort tool (abandon is per running stage only; `wait_run` abort cancels only the wait)
- `start_run` has no skip-gates, CI identity flags, or `--checkout` override (HITL always parks; checkout only via `task.checkout`)
- No catalog listing resource in v1 (use `list_pipelines` / `list_tasks`)
- No provider/settings/catalog-write MCP tools
- Default `get_run` / run resource read stay lean (no stage event streams or verification evidence); use `list_stage_events`, `get_envelope`, or `get_stage_verification` for detail
- Tools return JSON text content blocks
- One MCP/UI host per project root (do not run `sf ui` and `sf mcp` as peer writers)

## See also

- [Operator console](operator-console.md) — starts MCP alongside the UI
- [HITL](hitl.md) — gate kinds and answer shapes
- [CLI reference](cli-reference.md) — `sf ui`, `sf mcp`, `sf validate`, and host-down `sf runs` (inspect / wait / answer / retry / abandon / rerun). CLI `sf runs` is not a 1:1 MCP tool list; it does not clone catalog listing (`list_pipelines` / `list_tasks` / `describe_pipeline`).
- [CI / headless](ci.md) — MCP not used in CI jobs
- [Envelopes](envelopes.md) — artifact paths returned by `get_run` / `get_envelope`
