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

> **Breaking change (pipeline-owned catalog):** `list_pipelines` returns manifest filesystem paths, not bare pipeline ids. `start_run` requires a `pipeline` path and exactly one of `task_path` or inline `task`. Update MCP clients that passed ids like `"hello"`.

## Tools

### `list_pipelines`

List manifest-declared pipeline paths from the project catalog.

**Input:** `{}`

**Output:**

```json
{
  "pipelines": [
    "examples/hello-world/hello.pipeline.yaml",
    "examples/plan-review/plan-review.pipeline.yaml"
  ]
}
```

Paths are relative to the project git root (as declared in `stageflow.yaml`).

### `list_tasks`

List manifest-declared task paths from the project catalog.

**Input:** `{}`

**Output:**

```json
{
  "tasks": [
    "examples/hello-world/my-task.task.yaml",
    "examples/plan-review/my-task.task.yaml"
  ]
}
```

### `list_runs`

List known pipeline runs from the SQLite store.

**Input:** `{}`

**Output:** `{ "runs": [ … ] }`

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

**Output:** Projected run detail — status, stage statuses, envelope summary/payload/artifact paths (no events). When present on the run record, includes `pipeline_path` and `task_path` (catalog locators used to start the run).

Returns `404`-style error JSON when the run is not found.

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

Note: `stages/<stageId>/attempts/…` paths are **run workspace** layout, not catalog directories.

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

Exact config shape depends on your MCP client version.

## Limitations

- MCP requires `sf ui` — there is no standalone `sf mcp` command
- No tool to answer HITL gates in v1; use the operator console for replies
- Tools return JSON text content blocks

## See also

- [Operator console](operator-console.md) — starts MCP alongside the UI
- [CLI reference](cli-reference.md) — `sf ui`
- [CI / headless](ci.md) — MCP not used in CI jobs
- [Envelopes](envelopes.md) — artifact paths returned by `get_run`
