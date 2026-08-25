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

MCP tools operate on the **factory cwd** (the directory where you started `sf ui`) — the same catalog as CLI commands.

Implementation: `src/mcp/tools.ts`.

## Tools

### `list_pipelines`

List runnable pipeline ids from the factory cwd.

**Input:** `{}`

**Output:** `{ "pipelines": ["hello", "…"] }`

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

Start a pipeline with an **inline task object** (not a file under `tasks/`).

**Input:**

```json
{
  "pipeline": "hello",
  "task": {
    "id": "inline-task",
    "goal": "…",
    "context": "optional",
    "constraints": "optional",
    "checkout": "optional"
  }
}
```

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

**Output:** Projected run detail — status, stage statuses, envelope summary/payload/artifact paths (no events).

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
