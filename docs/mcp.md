---
layout: default
title: Mcp
---

# MCP

Stageflow serves **Streamable HTTP** MCP with **stateful sessions as the product default**. Host it via either:

- `sf ui` — operator console + MCP
- `sf mcp` — headless: same console REST API + MCP, minus the static console assets (no browser)

Default endpoint:

```
http://127.0.0.1:3847/mcp
```

The URL is printed on boot. Point Cursor or another MCP client at this URL while the host process is alive.

Stage agents consuming author-declared MCP is a different surface. Operator-host MCP can list catalog models and list or probe git-root `.mcp.json` servers the same way Settings and HTTP do; inspect is not attach. YAML `mcp:` still allowlists what a stage receives. See [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp).

**Breaking (Slot 6):** stage `.mcp.json` `${VAR}` interpolation resolves against the curated stage environment only — not Host ambient env. Declare tokens in `secrets:` (often `as: env`) or use `${VAR:-default}`. See [migration-stage-environment.md](migration-stage-environment.md).

## Sessions (how MCP works)

1. Client `POST /mcp` with an `initialize` request (no session header).
2. Server responds with an `Mcp-Session-Id` header.
3. Client opens `GET /mcp` with that header for the SSE listen channel (server→client notifications).
4. Subsequent tool / resource calls reuse the same session header on `POST /mcp`.
5. `DELETE /mcp` with the session header closes the session.

Sessions enable run **resource subscribe** and `notifications/resources/updated`. Without a GET listen stream, tools still work on the session; push updates will not be delivered.

`createHttpHost` applies a shared Host/Origin allow-list (see [Access control](#access-control)) on `/mcp` and every `/api/*` route. Absent `Origin` is allowed on ordinary routes; a present `Origin` must match the allow-list. Point clients at the advertised URL printed on boot (or the console Settings → MCP endpoint).

### Access control

| Env | Role |
|-----|------|
| `STAGEFLOW_ALLOWED_HOSTS` | Extra hostnames/IPs (optional `:port`). Unset → loopback only. Loopback always allowed. `*` rejected. |
| `STAGEFLOW_CONTROL_TOKEN` / `_FILE` | Bearer **drive** scope (implies read). Required when bind is non-loopback. |
| `STAGEFLOW_READ_TOKEN` / `_FILE` | Bearer **read** scope only. |

Send `Authorization: Bearer <token>` on protected requests.

| Surface | Scope |
|---------|-------|
| `GET`/`HEAD` `/api/*` | `read` |
| Mutating `/api/*` (`POST`/`PUT`/`PATCH`/`DELETE`) | `drive` |
| `/mcp` (any method) | `drive` |
| `GET /api/health` | Host/Origin only — **no bearer** (autostart probe) |
| A2A (`/a2a*`, agent card) | Unchanged (own per-caller tokens) |
| Static console files | Ungated |

Missing/malformed credentials → `401` + `WWW-Authenticate: Bearer`. Valid token, wrong scope → `403`. Host/Origin failures → `403` before bearer checks.

Non-loopback bind without a drive token refuses to start (exit `1`) with a stderr message naming the bind and how to set `STAGEFLOW_CONTROL_TOKEN`. Prefer `sf mcp` in containers with `STAGEFLOW_BIND=0.0.0.0`, `STAGEFLOW_CONTROL_TOKEN_FILE=…`, and `STAGEFLOW_ALLOWED_HOSTS` set to the public hostname. Until Slot 6, stage workers inherit `process.env` — treat the control token as Host-process secret hygiene.

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
| `sf mcp` | Console REST (no static assets) + `/mcp` | No |

`sf mcp` mounts the **same** `createOperatorRoutes` surface as `sf ui` — every `/api/*` route is available on both; only the console's static files are omitted. Both hosts apply the [access control](#access-control) Host/Origin allow-list and optional bearer scopes to `/mcp` and `/api/*`. Loopback with no token keeps the historical unauthenticated local UX.

Both use the same project git-root catalog and **global durable-root** run store (`$STAGEFLOW_HOME`, default `~/.stageflow/`) and default port `3847`. Run **either** `sf ui` **or** `sf mcp` for a given project root — not both (one writer process; the second bind on the same port fails). Different ports against the same store with two managers is unsupported. See [Data directory](data-directory.md).

MCP tools resolve the **project git root** for catalog browse and the **global durable root** for the run store — the same semantics as CLI commands, not the shell cwd where you started the host.

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
start_run → wait_run (until waiting/any) → decide_feedback_loop → wait_run (until terminal)
```

```
start_run → resources/subscribe(stageflow://runs/{runId}) → on updated, get_run / answer_gate / decide_feedback_loop
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

### `list_models`

List catalog model ids from the same browse source as `GET /api/models`.

**Input:** `{}`

**Output:**

```json
{
  "models": [
    "anthropic/claude-sonnet-4-5",
    "cursor/auto",
    "cursor/composer-2-5"
  ]
}
```

There is no model-write, filter, or provider-login tool.

### `list_project_mcp`

List git-root `.mcp.json` servers as names and coarse transport only (same helper as `GET /api/project-mcp`). List never interpolates, spawns, or returns env, headers, args, command, or URLs.

**Input:** `{}`

**Output:**

```json
{
  "status": "ok",
  "servers": [
    { "name": "local", "transport": "stdio" },
    { "name": "github", "transport": "http" }
  ]
}
```

`status` is `ok`, `missing_catalog`, or `invalid_config`. A reserved `stageflow` entry fails the whole catalog (`invalid_config`, empty `servers`), matching HTTP.

Inspect is not attach. Stage MCP YAML `mcp:` still allowlists what a stage receives — see [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp).

### `probe_project_mcp`

Probe one named git-root `.mcp.json` server with isolated connect-and-exit (same helper as `POST /api/project-mcp/:name/probe`). Aborting the MCP request maps to helper `cancelled`, not `wait_run` `aborted`. Probe does not attach servers to a stage.

**Input:** `{ "name": "github" }`

**Output:** `{ "name": "github", "status": "connected" }`

`status` is one of `connected`, `needs_auth`, `connect_failed`, `unresolved_var`, `invalid_config`, `missing_catalog`, `cancelled`. Helper statuses stay in the success payload (`isError` only if the tool itself fails).

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

**Output:** `{ "waiting": [ { "runId", "stageId", "waiting_kind?", "waiting_summary?", "waiting_prompt_id?", "pending_prompt?", "waiting_artifacts?", "waiting_questions?", "feedback_loop_id?", "deferred_target?" } ] }`

For `waiting_kind: "feedback_loop_decision"`, `feedback_loop_id` and `deferred_target` identify the exhausted loop.

### `get_waiting_summary`

Lightweight count and identity of waiting stages — no `pending_prompt`, `waiting_artifacts`, or `waiting_questions`. Use this for a status-bar badge or a small waiting-items list; use `list_waiting` when you need the full prompt detail.

**Input:** `{ "runId": "…", "path": "…" }` — both optional. `runId` scopes to one run (same as `list_waiting`). `path` scopes to one project, derived via the same `findProjectRoot` walk-up used everywhere else in this service. Omitting both spans every project the store knows about.

**Output:** `{ "count": number, "runs": [ { "runId", "stageId", "kind?" } ] }` — `kind` mirrors `list_waiting`'s `waiting_kind`.

### `list_providers`

List login-capable model providers with per-row auth readiness and a Pi-home detect summary (same helpers as HTTP `GET /api/providers`, `GET /api/providers/:id/auth`, and `GET /api/providers/detect`). Read-only: it does not log in, log out, or start OAuth.

**Input:** `{}`

**Output:**

```json
{
  "authShell": "pi",
  "via": "pi",
  "detect": {
    "piHomeUsable": true,
    "credentialSource": "sf_owned",
    "provisional": false,
    "source": "sf_owned"
  },
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "supportsApiKey": true,
      "supportsOauth": true,
      "oauthLabel": "Claude Pro/Max",
      "configured": true,
      "authKind": "oauth",
      "source": "stored"
    }
  ]
}
```

Env-only providers are omitted (same membership as `GET /api/providers`). An unconfigured provider is still a successful result with `configured: false`. Responses never include API keys, tokens, `authPath`, or credential file contents.

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

### `decide_feedback_loop` {#decide_feedback_loop}

Resolve a feedback-loop `wait_for_human` decision (same semantics as `POST /api/runs/:runId/stages/:stageId/feedback-decision` and CLI `sf runs feedback-decide`).

**Input:**

```json
{
  "runId": "…",
  "stageId": "review",
  "decision": "continue",
  "loopId": "…",
  "reason": "optional reason"
}
```

`decision` is `extend`, `continue`, or `abandon`. `loopId` and `reason` are optional. `stageId` is the feedback-loop **source** stage.

| Decision | Effect |
|----------|--------|
| `extend` | Increase `max_replays` by one and accept the deferred `send_back`. Optional `reason` is persisted on `feedback_loop_decided`. |
| `continue` | Mark the source succeeded and release the loop hold so successors can run. Optional `reason` is persisted on `feedback_loop_decided`. |
| `abandon` | Fail the source (run typically fails). Optional `reason` is persisted on `feedback_loop_decided` and on `{ event: "failed", reason }`. |

**Success:** `{ "ok": true, "effect": "extended"|"continued"|"abandoned", "loopId": "…" }`

**Errors (`isError: true`):** `404` unknown run/stage/loop; `409` no waiting feedback loop / wrong stage.

**Compose with `wait_run`**

```
start_run → wait_run (until waiting/any)
         → if waiting_kind is feedback_loop_decision: decide_feedback_loop
         → else: answer_gate
         → wait_run (until terminal)
```

Use `list_waiting` / nested `get_run` fields (`waiting_kind`, `feedback_loop_id`, `deferred_target`, `active_feedback_loop`) to distinguish HITL gates from exhausted feedback loops.

### `get_health`

Server health, soft-max run capacity, and on-demand durable-root disk breakdown.

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
  "maxActiveStageProcesses": null,
  "version": "0.20.0",
  "disk": {
    "runs_bytes": 0,
    "worktrees_bytes": 0,
    "repos_bytes": 0,
    "state_db_bytes": 0,
    "a2a_artifacts_bytes": 0,
    "free_bytes": 0
  }
}
```

`version` is the running server's npm package version — compare it against the version you built your integration against to detect a behavior change that isn't visible as a tool being added or removed.

`disk` is computed on demand: category byte totals under the durable root plus free space on that filesystem. When the walk fails, the Host still returns capacity fields and may omit or zero the breakdown.

Default `maxConcurrent` is 3 (override via `STAGEFLOW_MAX_CONCURRENT_RUNS` or console settings). `maxActiveStageProcesses` is `null` when unlimited.

When `slotsAvailable` is `0`, further starts are admitted to the **admission queue** (see `start_run`) until `STAGEFLOW_MAX_QUEUED` is also full.

### `start_run`

Start a pipeline run using a **filesystem pipeline path**, or an **inline
pipeline definition** authored directly in the call, and either a catalog
task file or an inline task object.

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
    "checkout": "optional",
    "input": { "ticket_id": "OSS-123" }
  }
}
```

**Input (inline pipeline):**

```json
{
  "pipeline": {
    "id": "quick-check",
    "stages": [
      {
        "id": "check",
        "system_prompt": "Review the diff for obvious bugs.",
        "io": {
          "input": { "schema": { "type": "object" } },
          "output": { "schema": { "type": "object" } }
        }
      }
    ]
  },
  "task": { "id": "t", "goal": "Check this change" }
}
```

An inline `pipeline` is the same pipeline model as a file — `id`, `stages: [...]`,
each stage the same shape as a YAML stage body (`system_prompt`, `io.input.schema`/
`io.output.schema`, optional `model`/`gate_kinds`/`mcp`/`verify`/`timeout_ms`/
`route`) — validated and executed through the exact same path a file-based
pipeline uses, so the same errors (missing `io`, bad DAG shape, duplicate
stage id) come back the same way. The one thing an inline pipeline can't do
is reference an external stage file (`uses:`) — every stage body must be
inline, since the whole point is nothing saved to disk. A run started from
an inline pipeline has no `pipeline_path` and cannot later be `rerun` — see
below.

Exactly one of `task_path` or `task` is required. Schema is only `pipeline` plus `task_path` or `task` — no skip-gates, no CI identity flags, and no `--checkout` override (checkout comes from `task.checkout` only). HITL always parks.

**Success output:** `{ "runId": "…" }` when a concurrency slot is free, or `{ "runId": "…", "queued": true, "queuePosition": N }` when slots are full but the admission queue still has room. Queued is still a success — poll with `wait_run` / `get_run` until the run leaves `queued` and reaches waiting or terminal.

**Error output** (`isError: true`):

| Reason | Code | Meaning |
|--------|------|---------|
| Admission queue full | `busy_capacity` | Includes `activeCount`, `maxConcurrent`, `activeRunIds`. Fired when `STAGEFLOW_MAX_QUEUED` cannot accept another queued run (not merely when active slots are full) |
| Checkout lease conflict | `busy_checkout` | Includes `conflictingRunId`, `conflictingCheckout`. Never queued |
| Free disk below floor | `insufficient_disk` | Includes `freeBytes`, `minFreeBytes`. Distinct from `busy_capacity`; the run is not created or queued |

Task schema matches `TaskFile` (`id`, `goal`, optional `context`, `constraints`, `checkout`, `input`). Optional `input` on the inline `task` object (or on a catalog task file) can satisfy an entry stage's `io.input`. If an entry declares `io.input` and the task has no `input`, start-run treats it as `{}` and fails with `task.invalid_shape` when that does not match.

### `get_run`

Poll run status without loading the full event stream.

**Input:** `{ "runId": "…" }`

**Output:** Projected run detail — status, stage statuses, envelope summary/payload/artifact paths (**no events**), and `pipeline_track` when present. A diamond join has two inbound track edges; a blocked join lists every unresolved parent in `blocked_by`. When a stage is waiting, includes run-level `waiting_*` fields and per-stage `pending_prompt`. When present on the run record, includes `pipeline_path` and `task_path`. Feedback-loop runs also expose `active_feedback_loop` (when a loop is `active` or `waiting_for_human`) and `feedback_loops` (history with replays and stage passes). On `on_max_replays: wait_for_human`, the loop **source** pass in `feedback_loops[].replays[].stage_passes` is `waiting` while parked, then `succeeded` after `extend`/`continue` or `failed` after `abandon`. The projection includes `total_cost_usd` and per-stage `cost_usd` / `definition_id` when the store has them.

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
| `terminal` | Run `status` is `succeeded`, `failed`, or `cancelled` |
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

**Abort ≠ cancel run:** cancelling the MCP request / aborting the handler signal ends only the wait (`isError` with `code: "aborted"`). The pipeline run continues. Use `cancel_run` to cancel the run itself.

**Optional progress:** if the client supplies `_meta.progressToken` on `tools/call`, the server may emit sparse `notifications/progress` during the poll loop. Progress is never required for correctness. Many clients default tool timeouts to ~60s; only clients that honor progress and `resetTimeoutOnProgress` benefit. Cursor behavior is unverified — pass a shorter `timeout_ms` when unsure.

**Node `requestTimeout`:** both `sf ui` and `sf mcp` disable Node’s default 300s `requestTimeout` so a max `timeout_ms` of 240s is not cut off by the socket layer.

**Compose with HITL**

```
start_run → wait_run (until waiting/any)
         → answer_gate
         → wait_run (until terminal)
```

**Compose with feedback-loop decisions**

```
start_run → wait_run (until waiting/any)
         → decide_feedback_loop   # when waiting_kind is feedback_loop_decision
         → wait_run (until terminal)
```

Prefer `wait_run` over chatty `get_run` loops when waiting for the next interaction point. Prefer resource subscribe when the client already holds a session GET listen stream. A coding-agent host may present the pending prompt on its native question UI; the submit path is still `answer_gate` (HITL) or `decide_feedback_loop` (exhausted feedback loop).

**Errors (`isError: true`):** `404` unknown run; `400` invalid `timeout_ms`; `code: "aborted"` when the client aborts the wait.

### `list_stage_events`

List persisted stage log events (lifecycle/activity). Optional `attempt` scopes to one attempt.

**Input:** `{ "runId", "stageId", "attempt?" }`

**Output:** `{ "runId", "stageId", "attempt?", "events": [ … ] }`

Lifecycle events include `{ event: "feedback_loop_decided", decision, loopId, reason? }` after a `decide_feedback_loop` CAS succeeds and before the source is marked `succeeded` or `failed`.

### `tail_stage_log`

Poll for new live assistant text a stage attempt has produced, since a byte-offset cursor. Separate from `list_stage_events` — no milestones, no prompt/artifact/question detail, just the raw text as it streamed out of the model, batched every ~300ms and redacted for secret-shaped substrings before it's ever written to disk. Every stage gets this by default; there's no pipeline flag to turn it on. Poll-only — no push/SSE delivery.

**Input:** `{ "runId", "stageId", "attempt?", "since_offset?" }` — `attempt` defaults to the stage's current/latest attempt. Omit `since_offset` on the first call to catch up on everything currently retained; pass back the previous response's `next_offset` on each subsequent call.

**Output:** `{ "text", "next_offset", "attempt_complete", "truncated?", "earliest_offset?" }`

- `attempt_complete`: `true` once that attempt is no longer the stage's actively-running one — poll until this flips, then stop.
- `truncated` + `earliest_offset`: only present when `since_offset` predated the retained window (the log is capped at 256 KB per attempt; the oldest half is dropped when it fills up). The response still serves everything currently retained (from `earliest_offset` onward) in the same call — no need to re-request first.

**Errors (`isError: true`):** `404` unknown run/stage.

### `get_stage_verification`

Read the after-phase verify history for one stage. Each attempt contains its verification
disposition, check statuses, and persisted evidence, including command output where
configured.

**Input:** `{ "runId", "stageId" }`

**Output:** `{ "run_id", "stage_id", "attempts": [{ "attempt", "status", "verification_outcome", "checks" }], "manual_recovery?" }`

Use this to understand an automatic repair: the failed attempt and the successful
repair are returned as separate records. It returns `404` when the run or stage is
unknown.

### `recover_manual_stage`

Explicitly authorize a new attempt after an `on_verify_fail.mode: manual` after-phase
verification failure. Optional `guidance` (up to 4,000 characters) is persisted and
supplied to the agent along with the failed-check capsule.

**Input:** `{ "runId", "stageId", "guidance?" }`

### `stop_manual_recovery`

Record the operator decision to leave a manual-recovery stage failed. It cannot be
recovered again in that run.

**Input:** `{ "runId", "stageId" }`

### `get_envelope`

Read the full `StageEnvelope` for a stage. Optional `attempt` (omit = latest). A provided attempt reads that execution's stored envelope.

**Input:** `{ "runId", "stageId", "attempt?" }`

**Output:** `{ "runId", "stageId", "attempt?", "envelope": { … } }`

Returns `404` when the run, stage, or envelope is missing. MCP does **not** synthesize an envelope for fork-skipped stages. CLI `envelope get` synthesizes `{ status: "skipped", summary: "stage was fork-skipped", artifacts: [], fork_choice: null }` when the stage is skipped and no envelope is stored.

### `read_artifact`

Read a run-workspace artifact by relative path.

**Input:**

```json
{
  "runId": "…",
  "path": "stages/clarify/attempts/1/artifacts/plan.md"
}
```

**Output** depends on the file:

- Known image extensions (`png`, `jpeg`/`jpg`, `gif`, `webp`) — mime is by extension, not magic bytes. Primary content is an MCP image block `{ "type": "image", "mimeType", "data" }` (`data` is standard base64). A second JSON text block may include `{ "runId", "path", "mimeType" }` identity and does not repeat file bytes.
- Valid UTF-8 non-image files — JSON text `{ "runId", "path", "content" }`.
- Non-image files that are not valid UTF-8 — `isError` with `{ "error", "status": 400 }`.

Path must be relative, with no `..`, and contained under the run workspace. Denied: any `.pi-agent` path segment, and files named `auth.json` (same rules as CLI `sf artifact read`). Returns `404` for missing run or artifact.

Note: `stages/<stageId>/attempts/…` paths are **run workspace** layout, not catalog directories.

### `validate`

Validate the project catalog, a pipeline path, or a task path (same authority as `sf validate`).

**Input:** `{ "pipeline?", "task?", "strict?" }`

Scope is inferred: `pipeline` set → pipeline scope; else `task` set → task scope; else full catalog (pipelines **and** tasks). If both `pipeline` and `task` are set, **pipeline wins** (CLI `sf validate` rejects both).

**Output:** `ValidationResult` — `{ "scope", "ok", "summary": { "errors", "warnings" }, "findings": [ … ] }` (findings include severity, code, `path`, message, category, and optional pipeline/stage ids). MCP keeps `path`; CLI `--json` remaps that field to `file`.

### `describe_pipeline`

Describe a pipeline DAG from a filesystem pipeline path (same locator style as `start_run`).

**Input:** `{ "pipeline": "pipelines/diamond-fan-in.pipeline.yaml" }`

**Output:**

```json
{
  "id": "diamond-fan-in",
  "path": "…",
  "stages": [
    { "id": "clarify", "needs": null, "gate_kinds": ["free_text"] },
    { "id": "research", "needs": "clarify" },
    { "id": "validation", "needs": "clarify" },
    {
      "id": "synthesize",
      "needs": [
        { "id": "research", "on": ["succeeded"] },
        { "id": "validation", "on": ["succeeded"] }
      ]
    }
  ]
}
```

Catalog YAML authors outbound `route`; `describe_pipeline` still returns the **resolved** inbound snapshot as `needs` from `loadPipeline` (inverted from `route`). It is JSON, not `sf graph` ASCII.

Scalar `needs` stays a string or `null` when the stage has one parent, default `on: ["succeeded"]`, and no `if`. A single parent becomes a one-element structured array `{ id, on, if? }` when that edge has `if` or a non-default `on`. A multi-parent join exposes the structured array (each item `{ id, on }`, plus `if` when present), including default `on: ["succeeded"]` for string YAML items. Omit `if` when the predicate is absent. See [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml).

Stage objects also include optional `clone_cap` and `clone_mode` on a Clone Chain emitter, plus `feedback_loop`, `entry`, and `replay_safe` when those fields are set on the resolved node.

`sf run --json --include stages` does not include this graph — use `get_run` or `sf runs show --json` for `pipeline_track`.

### `retry_stage`

Retry a **failed** stage (same as HTTP `POST .../retry`).

**Input:** `{ "runId", "stageId" }`

**Success:** `{ "runId", "stageId", "attemptIndex" }`

Waiting stages are not retryable (`409`, often `code: "hitl_not_retriable"`) — use `answer_gate` instead.

### `resume_stage`

Resume an **interrupted** stage or a stage that **timed out**, continuing the same attempt/session (same as HTTP `POST .../resume`). Does not start a new attempt — use `retry_stage` to start over.

**Input:** `{ "runId", "stageId" }`

**Success:** `{ "runId", "stageId", "attemptIndex" }` (same attempt as the interrupted or timed-out pass)

Fails with `409` if the stage is neither `interrupted` nor a timeout-shaped `failed`, or if the session file is missing (use `retry_stage` to start a new attempt).

### `abandon_stage`

Abandon a **running** stage (marks it failed). Does **not** dismiss HITL waiting gates (`409` if waiting) — answer those with `answer_gate`. Prefer `cancel_run` to stop an entire run.

**Input:** `{ "runId", "stageId" }`

**Success:** `{ "ok": true, "runId", "stageId" }`

### `cancel_run`

Cancel a non-terminal run (`created` / `queued` / `running`). Marks the run `cancelled`, terminalizes pending/running/waiting stages, and releases the checkout lease. Required free-text `reason` is stored as `cancel_reason`.

**Input:** `{ "runId": "…", "reason": "…" }`

**Success:** `{ "ok": true, "runId": "…" }`

Cancel signals live stage workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included in the tree.

Until Slot 5 authentication, this mutating tool (and the matching `POST /api/runs/:runId/cancel` REST route) relies on the Host's existing `isMutatingApi` loopback `Host` / `Origin` gate and local bind assumptions — not a bearer token.

### `delete_run`

Hard-delete a terminal run (store rows, workspace, worktree, run branch, and A2A tasks/artifacts). Irreversible. Active runs (`created` / `queued` / `running`) require `force: true`, which cancels first then deletes.

**Input:** `{ "runId": "…", "force"?: boolean }`

**Success:** `{ "ok": true, "runId": "…" }`

Same Slot 5 note as `cancel_run`: until auth lands, destructive MCP/REST (`delete_run`, `DELETE /api/runs/:runId`) rely on `isMutatingApi` + local bind only.

### `gc_runs`

Run retention GC (SLIM, then PURGE, then bare-cache eviction). Default `execute: false` is dry-run (report candidates only). `execute: true` is irreversible bulk reclaim.

**Input:** `{ "execute"?: boolean }`

**Success:** `{ "slimmed": […], "purged": […], "bareCachesEvicted": […] }`

Matching REST: `POST /api/runs/gc` with the same body. Same Slot 5 auth caveat as other destructive verbs. There is no operator-console GC button in this release — CLI/MCP are primary.

### `rerun`

Start a new run from a stored run’s `pipeline_path` plus task YAML (`RunManager.rerun`). Does **not** require the source run to be completed or failed (unlike CLI `sf export-run`, which requires `succeeded` or `failed`).

**Input:** `{ "runId": "…" }`

**Success:** `{ "runId": "…" }` (new run id)

Fails if catalog locators are missing (`400` / `404`). May return the same busy / disk codes as `start_run` (`busy_capacity`, `busy_checkout`, `insufficient_disk`), including a queued success shape when admitted to the queue.

A run started from an inline pipeline (see `start_run`) has no `pipeline_path`
to replay from, so `rerun` fails with this same "missing pipeline_path" error
— there's no special-cased error for inline runs. If you want a run to be
replayable later, save the pipeline to a file.

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

- Cancel signals workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included
- Until Slot 5, destructive MCP/REST verbs (`cancel_run`, `delete_run`, `gc_runs`, and their HTTP routes) rely on `isMutatingApi` loopback gating and local bind — not application auth. Slot 5 must cover MCP tools as well as HTTP
- `start_run` has no skip-gates, CI identity flags, or `--checkout` override (HITL always parks; checkout only via `task.checkout`)
- No catalog listing resource in v1 (use `list_pipelines` / `list_tasks` / `list_models`)
- No provider login/logout/OAuth, settings-write, catalog-write, or Stage MCP attach MCP tools (`list_providers`, `list_models`, `list_project_mcp`, and `probe_project_mcp` are read-only inspect)
- Default `get_run` / run resource read stay lean (no stage event streams or verification evidence) and include `total_cost_usd` plus per-stage `cost_usd` / `definition_id` when the store has them; use `list_stage_events`, `get_envelope`, or `get_stage_verification` for detail
- Tools return JSON text content blocks, except `read_artifact`, which may return an MCP image content block for known image extensions
- One MCP/UI host per project root (do not run `sf ui` and `sf mcp` as peer writers)

## See also

- [YAML catalog — Stage MCP](yaml-catalog.md#stage-mcp) — project `.mcp.json`, Settings inspect, and stage `mcp` names (not this host)
- [Operator console](operator-console.md) — starts MCP alongside the UI
- [HITL](hitl.md) — gate kinds and answer shapes
- [CLI reference](cli-reference.md) — `sf ui`, `sf mcp`, `sf validate`, and host-down `sf runs` (inspect / wait / answer / feedback-decide / retry / resume / abandon / cancel / delete / gc / rerun). CLI `sf runs` is not a 1:1 MCP tool list; it does not clone catalog listing (`list_pipelines` / `list_tasks` / `describe_pipeline`).
- [YAML catalog — Feedback loops](yaml-catalog.md#feedback-loops) — `feedback_loop` / `replay_safe` policy
- [CI / headless](ci.md) — MCP not used in CI jobs
- [Envelopes](envelopes.md) — artifact paths returned by `get_run` / `get_envelope`
