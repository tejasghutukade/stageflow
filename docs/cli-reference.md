---
layout: default
title: Cli Reference
---

# CLI reference

The `sf` and `stageflow` binaries expose the same commands. Run `sf --help` for the full usage string.

## Storage locations

| Path | Purpose |
|------|---------|
| `$STAGEFLOW_HOME` (default `~/.stageflow/`) | Global durable root — SQLite run store (`state.db`, including the projects registry), run workspaces (`runs/`), `sf_owned` auth (`agent/auth.json`), global `settings.json`, `service.log` |
| `<git-root>/.stageflow/settings.json` | Per-project settings (`maxConcurrent`, `credentialSource`) when run from inside a git repo; not the run store |

Override the durable root with `STAGEFLOW_HOME`. See [Data directory](data-directory.md) for the full tree (keep vs disposable), image user, and version support.

Store backend: `SF_STORE=sqlite` only; `SF_STORE=disk` is rejected. If SQLite has no runs yet, a disk-era nested `runs` tree may be imported; if a project `.stageflow` is missing and `.software-factory` exists, the next project-settings open renames it.

## Global

```bash
sf --version
sf -V
sf --help
```

`sf --version` and `sf -V` print the npm package version on stdout and exit `0`. They do not open a catalog, run store, or git root.

## `sf init`

Scaffold a new Stageflow project at the git root (or current directory when not in git).

```bash
sf init
```

Creates (skipping files that already exist):

| File | Purpose |
|------|---------|
| `stageflow.yaml` | Manifest with `pipelines/` and `tasks/` roots |
| `pipelines/hello.pipeline.yaml` | Inline single-stage pipeline |
| `tasks/hello.task.yaml` | Sample task |

Also ensures the durable root (`$STAGEFLOW_HOME`, default `~/.stageflow/`) exists for global config.

## `sf run`

Run a pipeline against a task file.

```bash
sf run --task <path> --pipeline <path> [--checkout <path>] [--repository <owner/repo>] [--ref <ref>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]
```

| Flag | Description |
|------|-------------|
| `--task` | Path to a task YAML file (required) |
| `--pipeline` | Filesystem path to a pipeline YAML file (required) |
| `--checkout` | Override task `checkout` with a working tree path (conflicts with `--repository` / task `repository`) |
| `--repository` | Override task `repository` (`owner/repo` GitHub form) for a Host-owned worktree binding |
| `--ref` | Override task `ref` (branch, tag, or SHA); required when binding by repository |
| `--json` | Print one JSON document to stdout |
| `--include stages` | With `--json`, append `stages[]` run projection (requires `--json`) |
| `--skip-gates` | Fail the stage instead of waiting on HITL (see [HITL](hitl.md)) |
| `--git-sha` | Record git SHA on the run (CI identity) |
| `--ci-pr-url` | Record PR URL on the run |
| `--ci-job-url` | Record CI job URL on the run |
| `--operator-cwd` | Accepted for compatibility but has **no effect** on `sf run` — see note below |
| `--operator-agent-dir` | Accepted for compatibility but has **no effect** on `sf run` — see note below |

`sf run` is an HTTP client of the shared global Stageflow service (started/reused across invocations, see [`sf ui`](#sf-ui) / [`sf mcp`](#sf-mcp)); it no longer constructs a per-invocation `RunManager`, so `--operator-cwd`/`--operator-agent-dir` can't be threaded through per call. Passing either flag prints a warning and is otherwise a no-op. Set `STAGEFLOW_OPERATOR_CWD` / `STAGEFLOW_OPERATOR_AGENT_DIR` in the environment **before that service first starts** instead — the operator catalog used for skill resolution is fixed once, at daemon start. See [CI: Skills in CI](ci.md#skills-in-ci).

**Project identity.** Pipeline/task paths resolve from the CLI cwd (relative or absolute local paths). Before `start_run`, the CLI ensure-registers that resolved project folder with the Host (`POST /api/projects` on trusted loopback), then sends catalog-relative paths plus `project_root` for that folder. Host boot cwd does not define the run's project. Remote MCP/HTTP callers cannot ensure arbitrary paths — they may only use already-registered or seeded roots. See [MCP — catalog roots](mcp.md#catalog-roots-and-project_root) and [Data directory](data-directory.md).

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Pipeline succeeded |
| `1` | Failed (stage error, validation error, cancelled, busy start, insufficient disk, or `--skip-gates` on HITL) |
| `2` | Pipeline waiting on operator input |

**JSON outcomes** (`--json`):

| `outcome` | `ok` | `runId` | exit |
|-----------|------|---------|------|
| `succeeded` | `true` | present | `0` |
| `failed` | `false` | present (omit if start never created a run) | `1` |
| `cancelled` | `false` | present | `1` |
| `waiting` | `false` | present | `2` |
| `busy` | `false` | omit | `1` |

Busy codes: `busy_capacity` (admission queue full — active-slot exhaustion queues instead), `busy_checkout` (same checkout leased; never queued). Disk floor miss is `outcome: "failed"` with `code: "insufficient_disk"` (not busy). When slots are full but the queue has room, start succeeds; blocking `sf run` may print `queued at position N` on stderr before waiting for terminal. See [CI / headless](ci.md#json-stdout).

Cancel signals stage workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included. Until Slot 5 auth, destructive Host verbs rely on `isMutatingApi` loopback gating and local bind only.

Validation failure during `sf run --json` prints **validate-shaped** JSON (`ok`, `scope`, `checks`, `findings`…) with **no** `outcome` / `runId` (exit `1`). Start-run pairing warnings (for example `pipeline.model_applies`) appear as optional `findings[]` on the completion document (`file` remapped from `path`) and do not change `ok` / `outcome` / exit codes. Omitted `task.input` is `{}` against entry `io.input.schema`; mismatch is `task.invalid_shape` and fails start-run. See [CI / headless](ci.md#json-stdout).

Example:

```bash
sf run --task tests/fixtures/tasks/sample.task.yaml --pipeline tests/fixtures/pipelines/single.pipeline.yaml --json
```

With stage projections (CI / post-run extraction):

```bash
sf run --task examples/hello-world/my-task.task.yaml \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --json --include stages > sf-run.json
```

Each `stages[]` item is a `StageProjection` (snake_case): `stage_id`, `status`, `envelope`, `artifacts`, and optional `last_at`, `pending_prompt`. That `--include stages` schema is unchanged for diamond runs — it does not add `pipeline_track` or join-input fields. The multi-edge graph (a diamond join has two inbound `pipeline_track` edges; `blocked_by` lists unresolved parents) is on `sf runs show --json`, MCP `get_run`, and `sf export-run`.

`--include stages` without `--json` exits `1`. See [CI / headless](ci.md#including-stage-projections).

## `sf run-stage` {#sf-run-stage}

Run a single stage directly against the shared Stageflow service, without authoring a pipeline file — the CLI counterpart of the MCP [`run_stage`](mcp.md#run_stage) tool (it talks to the same running `sf ui`/`sf mcp` service over MCP). Distinct from the internal-only, worker-process-only `sf internal run-stage` below.

```bash
sf run-stage (--stage <path> | --stage-inline '<json>') (--task <path> | --task-inline '<json>' | --envelope-ref <runId>:<stageId>[:<attempt>] [--envelope-ref ...]) [--checkout <path>] [--model <id>] [--blocking] [--timeout-ms <n>] [--json]
```

| Flag | Description |
|------|-------------|
| `--stage` | Filesystem path to a catalog stage YAML file |
| `--stage-inline` | Inline stage body JSON (`{ id, system_prompt, io, ... }` — no `uses:`/`route:`/pipeline wrapper) |
| `--task` | Filesystem path to a catalog task YAML file |
| `--task-inline` | Inline task JSON (`{ id, goal, ... }`) |
| `--envelope-ref` | Resolve a previously stored `StageEnvelope` as this stage's input instead of a task: `<runId>:<stageId>[:<attempt>]`. Repeat the flag to pass more than one — each resolved payload is namespaced under its `stageId` in `input` (disambiguated by `runId` on a `stageId` collision), and summaries are combined into `goal` |
| `--checkout` | Optional working directory to use with `--envelope-ref` (`--task`/`--task-inline` carry their own checkout) |
| `--model` | Override the model/backend for this call only, ahead of the stage's own declared model |
| `--blocking` | Wait for the run to reach a terminal or waiting state and print the result in this same call, instead of just printing the run id |
| `--timeout-ms` | Wait budget in ms when `--blocking` is set |
| `--json` | Machine-readable JSON output |

Exactly one of `--stage`/`--stage-inline` is required, and exactly one of `--task`/`--task-inline`/`--envelope-ref`.

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Async mode: call accepted, run started. Blocking mode: stage completed with a successful envelope |
| `1` | Tool-level error (bad input, validation failure, unknown `envelope_ref`), or blocking mode completed with a failed envelope |
| `2` | Blocking mode: the stage parked on a human-in-the-loop gate (`needs_input`), or the `--timeout-ms` budget elapsed before the run finished |

Async mode (the default) prints `{ runId, stageId }` and exits `0` immediately — poll or inspect with `sf runs show --run <runId>` / `sf runs wait --run <runId>` like any other run.

Examples:

```bash
# Async: start a catalog stage, print the run id
sf run-stage --stage stages/research.yaml --task tasks/research.task.yaml

# Blocking: wait for the result in this same call
sf run-stage --stage stages/research.yaml --task-inline '{"id":"t","goal":"Research it"}' --blocking

# Chain off a prior run's envelope instead of a task
sf run-stage --stage stages/summarize.yaml --envelope-ref 2026-09-21T17-44-36-201Z-9411d9:research --blocking

# Combine two prior results in one call
sf run-stage --stage stages/combine.yaml \
  --envelope-ref 2026-09-21T17-44-36-201Z-9411d9:research \
  --envelope-ref 2026-09-21T17-48-08-307Z-cc78f9:titleize \
  --blocking
```

Access is deliberately unrestricted, the same as the MCP tool: `sf run-stage` can run any catalog or inline stage the caller names, with no publish/allowlist step.

## `sf runs`

Inspect and control existing stored runs (in-progress, parked, or terminal). These verbs are not a 1:1 MCP tool list and they do not list pipelines or tasks. `sf run` stays the blocking start command.

```bash
sf runs list [--status created|queued|running|succeeded|failed|cancelled] [--since <iso>] [--pipeline <id-or-path>] [--json]
sf runs show --run <runId> [--from <sf-run.json>] [--json]
sf runs verify --run <runId> --stage <stageId> [--json]
sf runs recover --run <runId> --stage <stageId> [--guidance <text>] [--stop] [--json]
sf runs waiting [--run <runId>] [--json]
sf runs wait --run <runId> [--from <sf-run.json>] [--until any|waiting|terminal] [--timeout-ms <n>] [--json]
sf runs answer --run <runId> --stage <stageId> [--answer '<json>'] [--json]
sf runs feedback-decide --run <runId> --stage <sourceStageId> [--loop <loopId>] --decision extend|continue|abandon [--reason <text>] [--json]
sf runs retry --run <runId> --stage <stageId> [--json]
sf runs resume --run <runId> --stage <stageId> [--json]
sf runs abandon --run <runId> --stage <stageId> [--json]
sf runs cancel --run <runId> --reason <text> [--json]
sf runs delete --run <runId> [--force] [--json]
sf runs gc [--dry-run] [--json]
sf runs rerun --run <runId> [--json]
```

| Subcommand | Role |
|------------|------|
| `list` | Stored runs (same filters as MCP `list_runs`) |
| `show` | Live `projectRun` for any run status (not the `export-run` completeness gate) |
| `verify` | After-phase verify attempts, verification dispositions, and evidence for one stage |
| `recover` | Explicitly retry or stop a manual-recovery stage |
| `waiting` | Waiting gates with `pending_prompt` |
| `wait` | Block until waiting, terminal, or timeout |
| `answer` | Submit an `AskOperatorAnswer` for a parked stage |
| `feedback-decide` | Resolve a feedback-loop `wait_for_human` decision (`extend` / `continue` / `abandon`) |
| `retry` | Retry a failed stage; process waits until waiting or terminal |
| `resume` | Continue a timed-out failed attempt on the same session |
| `abandon` | Mark a running stage abandoned |
| `cancel` | Cancel a non-terminal run (`created` / `queued` / `running`) |
| `delete` | Hard-delete a terminal run (`--force` cancels then deletes an active run) |
| `gc` | Retention SLIM/PURGE + bare-cache eviction (`--dry-run` report-only) |
| `rerun` | Start a new run from a stored run; process waits until waiting or terminal |

`--from` is accepted on `show` and `wait` only (reads `runId` from a prior `sf run --json` file). `--answer` is `answer` only.

### Read vs mutate

| Kind | Verbs | Path |
|------|-------|------|
| Read | `list`, `show`, `verify`, `waiting`, `wait` | Open the global run store in assert mode (no schema changes in the CLI). If `state.db` is missing or behind this binary, start the Host first so it can migrate, then reopen |
| Mutate | `answer`, `feedback-decide`, `retry`, `resume`, `recover`, `abandon`, `cancel`, `delete`, `gc`, `rerun` | Sent over HTTP to the global service |

Read verbs that open the store themselves (`list`, `show`, `verify`, `waiting`, `wait`) and the related `sf artifact` / `sf envelope` / `sf export-run` commands do not apply migrations in the CLI process. When the database is missing or its schema version is behind, they start the Host the same way mutating verbs do, then open again in assert mode. Autostart may append to `$STAGEFLOW_HOME/service.log`.

Mutating verbs require the global service and do not write the store themselves. They probe `GET http://127.0.0.1:3847/api/health` (1500 ms) and, when nothing answers, spawn a detached `sf mcp` on that port and poll until it is healthy (default 10 s, `STAGEFLOW_AUTOSTART_TIMEOUT_MS`). Exit `1` when the port is held by a non-Stageflow process, the spawn fails, or the wait times out. `sf run` starts runs the same way.

Until Slot 5 authentication, destructive mutate verbs (`cancel`, `delete`, `gc` and their REST routes) rely on the Host's `isMutatingApi` loopback `Host` / `Origin` gate and local bind assumptions — not a bearer token. Slot 5 must cover MCP tools as well as HTTP.

### Parked runs

A HITL park keeps store status `running`. `--status waiting` is not a valid `list` filter; use `sf runs waiting`.

### JSON and exits

`--json` pretty-prints one document. Two families:

**Inspect / wait / answer** — MCP field names for the overlapping verb:

| Verb | `--json` shape | Exit |
|------|----------------|------|
| `list` | `{ "runs": [ … ] }` | `0` success, `1` error |
| `show` | `projectRun` object | `0` success, `1` error |
| `verify` | Stage verification history: attempts, dispositions, checks, and evidence | `0` success, `1` error |
| `recover` | Completion result after an approved retry, or `{ "ok", "runId", "stageId" }` for `--stop` | `0` success, `1` error, `2` waiting after retry |
| `waiting` | `{ "waiting": [ … ] }` | `0` success, `1` error |
| `wait` | waitRun result: `ok`, `reason`, `elapsed_ms`, `until`, nested `run` | `0` for `waiting` / `terminal` / `already` / `timeout`; **130** (or platform abort) with `{ "error", "code": "aborted" }` |
| `answer` | `{ "ok": true }` | `0` on success even if the run parks again; `1` on error |
| `feedback-decide` | `{ "ok": true, "effect": "extended"\|"continued"\|"abandoned", "loopId" }` | `0` on success; `1` on error |

Do not treat `answer` `{ "ok": true }` as terminal — call `sf runs wait` / `waiting` for the next state. Do not reuse `sf run` exit `2` for a completed `wait` that woke on waiting.

**Retry / resume / rerun / abandon / cancel / delete / gc:**

| Verb | `--json` shape | Exit |
|------|----------------|------|
| `retry`, `rerun` | `sf run` completion JSON (`ok`, `outcome`, `runId`, …) | `0` succeeded, `1` failed/busy/cancelled, `2` waiting |
| `resume` | `{ "ok", "runId", "stageId", "attemptIndex" }` | `0` success, `1` error |
| `abandon` | `{ "ok", "runId", "stageId" }` | `0` success, `1` error |
| `cancel` | `{ "ok", "runId" }` | `0` success, `1` error |
| `delete` | `{ "ok", "runId" }` | `0` success, `1` error |
| `gc` | `{ "slimmed", "purged", "bareCachesEvicted" }` | `0` success, `1` error |

### `sf runs list`

| Flag | Description |
|------|-------------|
| `--status` | `created` \| `queued` \| `running` \| `succeeded` \| `failed` \| `cancelled` |
| `--since` | ISO timestamp; keep runs with `created_at >= since` |
| `--pipeline` | Match `pipeline_id` or `pipeline_path` |
| `--json` | Pretty-printed `{ "runs": [ … ] }` |

### `sf runs show`

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--from` | Read `runId` from a prior `sf run --json` output file |
| `--json` | Pretty-printed `projectRun` |

Works for in-progress and parked runs. `sf export-run` writes the same `projectRun` object (including `pipeline_track`; diamond joins show both inbound edges) and does not take a separate `--json` flag. `--include stages` on `sf run --json` stays a flat `stages[]` list and does not carry that graph.

When a feedback loop is active or waiting, `--json` includes `active_feedback_loop` and `feedback_loops` (history with replays / stage passes). On `on_max_replays: wait_for_human`, the loop source pass is `waiting` while parked, then `succeeded` after `extend`/`continue` or `failed` after `abandon`. See [YAML catalog — Feedback loops](yaml-catalog.md#feedback-loops).

### `sf runs verify`

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--stage` | Stage id (required) |
| `--json` | Attempt-scoped verification dispositions, checks, and stored evidence |

Use this to see whether verification ran, why an after-phase verify item failed, and what an
automatic repair later changed. It is intentionally stage-scoped, so run listings do
not carry command output.

### `sf runs recover`

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--stage` | Stage id (required) |
| `--guidance` | Optional instruction recorded for the next agent attempt |
| `--stop` | Record the decision to leave the stage failed; cannot be combined with `--guidance` |
| `--json` | Completion JSON after retry, or the recorded stop decision |

Only a stage with `on_verify_fail.mode: manual` that failed after-phase verification is
eligible. A recovery retry starts a fresh attempt; a stop is terminal for that stage
in this run.

### `sf runs waiting`

| Flag | Description |
|------|-------------|
| `--run` | Limit to one run (omit to scan all) |
| `--json` | Pretty-printed `{ "waiting": [ … ] }` (MCP `list_waiting` fields, including `pending_prompt`) |

For `waiting_kind: "feedback_loop_decision"`, entries also carry `feedback_loop_id` and `deferred_target` (exhausted `wait_for_human` loop). Resolve with [`sf runs feedback-decide`](#sf-runs-feedback-decide).

### `sf runs wait`

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--from` | Read `runId` from a prior `sf run --json` output file |
| `--until` | `any` (default), `waiting`, or `terminal` |
| `--timeout-ms` | Wait budget in ms. Default `60000`. Must be in `(0, 240000]`. |
| `--json` | Pretty-printed waitRun result |

`reason` is `waiting` \| `terminal` \| `timeout` \| `already`. Timeout is success (`ok: true`, exit `0`); the run is unchanged. Abort cancels only the wait, not the run.

Park-and-answer loop:

```
sf runs waiting → sf runs answer → sf runs wait --until any
  reason waiting  → waiting then answer
  reason terminal → done
  reason timeout  → wait again
```

### `sf runs answer`

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--stage` | Stage id (required) |
| `--answer` | `AskOperatorAnswer` JSON |
| `--json` | `{ "ok": true }` on success |

If `--answer` is omitted, read stdin JSON only when stdin is not a TTY. On a TTY or empty stdin, exit `1` with a missing-answer error.

Answer kinds match [HITL](hitl.md) (`free_text`, `confirm`, `artifact_backed`, `multi_question`).

### `sf runs feedback-decide` {#sf-runs-feedback-decide}

Resolve a feedback-loop park when the source policy uses `on_max_replays: wait_for_human` and the loop is `waiting_for_human`.

```bash
sf runs feedback-decide \
  --run <runId> \
  --stage <sourceStageId> \
  [--loop <loopId>] \
  --decision extend|continue|abandon \
  [--reason <text>] \
  [--json]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--stage` | Feedback-loop **source** stage id (required) |
| `--loop` | Optional loop id when more than one loop could match |
| `--decision` | `extend` — bump `max_replays` by one and accept the deferred `send_back`. `continue` — treat the source as succeeded and advance downstream. `abandon` — fail the source (and typically the run) |
| `--reason` | Optional text persisted on `feedback_loop_decided` for `extend`, `continue`, and `abandon` |
| `--json` | `{ "ok": true, "effect": "extended"\|"continued"\|"abandoned", "loopId" }` |

Same semantics as MCP [`decide_feedback_loop`](mcp.md#decide_feedback_loop) and `POST /api/runs/:runId/stages/:stageId/feedback-decision`. Mutate rules apply (needs the global service on the default port; auto-started when absent).

Inspect loop state with `sf runs show --json` (`active_feedback_loop`, `feedback_loops`) and `sf runs waiting` (`waiting_kind: "feedback_loop_decision"`).

### `sf runs retry` / `resume` / `abandon` / `rerun`

Human/API parity for the remaining control verbs. Waiting stages are not retryable or abandonable. `resume` continues an **interrupted** stage or a **timed-out** failed attempt on the same session (does not start a new attempt). `retry` and `rerun` block in-process until waiting or terminal (same `0` / `1` / `2` as `sf run`). MCP `{ "runId" }` fire-and-forget is not the CLI contract.

### `sf runs cancel`

Cancel a non-terminal run. Required `--reason` is stored as `cancel_reason`.

```bash
sf runs cancel --run <runId> --reason <text> [--json]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--reason` | Free-text cancel reason (required) |
| `--json` | `{ "ok": true, "runId" }` |

Signals live stage workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included. Same mutate / Slot 5 auth notes as other destructive Host verbs.

### `sf runs delete`

Hard-delete a terminal run (store + workspace + worktree + run branch + A2A). Irreversible.

```bash
sf runs delete --run <runId> [--force] [--json]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--force` | Cancel first when the run is still `created` / `queued` / `running`, then delete |
| `--json` | `{ "ok": true, "runId" }` |

Without `--force`, an active run returns an error. Same Slot 5 auth caveat.

### `sf runs gc`

Run retention GC (SLIM, then PURGE, then bare-cache eviction).

```bash
sf runs gc [--dry-run] [--json]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report candidates only (default without this flag is execute) |
| `--json` | `{ "slimmed", "purged", "bareCachesEvicted" }` |

`--dry-run` is report-only; omitting it mutates. Matching MCP tool is `gc_runs` with `execute` (default `false` = dry-run). No operator-console GC button in this release.

## `sf envelope get`

Read a stage envelope or CI handoff JSON from the run store.

```bash
sf envelope get --run <runId> --stage <stageId> [--json] [--from <sf-run.json>] [--detect-stage <id>] [--format envelope|handoff]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--stage` | Stage id to read (required). |
| `--from` | Read `runId` / `runDir` from a prior `sf run --json` output file |
| `--detect-stage` | For `--format handoff`: when this stage emitted `fork_choice: []`, output `{ skipped: true }` and exit `0` |
| `--format` | `envelope` (default) — raw stage envelope; `handoff` — downstream deliverables shape |
| `--json` | Print JSON to stdout |

**Handoff format** (`--format handoff`):

| Shape | When |
|-------|------|
| `{ "skipped": true }` | Detect stage emitted `fork_choice: []` (when `--detect-stage` is set) |
| `{ skipped: false, runId, runDir, stageId, diagrams: [{ diagram_type, spec_path, summary }] }` | Author stage succeeded with spec artifacts |

With `--from sf-run.json`, handoff requires the run document to have `outcome: "succeeded"` and `ok: true`.

**Exit codes:** `0` success, `1` error (missing args, envelope not found, handoff build failure).

Example (Archify-on-PR):

```bash
sf envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
```

See [CI: handoff envelope extraction](ci.md#handoff-envelope-extraction) and [Envelopes: CI consumption](envelopes.md#ci-consumption).

## `sf export-run`

Export a portable run projection for debug or audit.

```bash
sf export-run --run <runId> [--from <sf-run.json>] [--out <file>]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--from` | Read `runId` from a prior `sf run --json` output file |
| `--out` | Write JSON to a file under the current working directory (stdout when omitted). Path must stay under cwd (no `..`); absolute paths are accepted when they realpath to the same directory (for example `/tmp` vs `/private/tmp` on macOS). |

Writes the full `projectRun` projection (includes `pipeline_track` and waiting fields). Accepts any recorded run status. Does not take `--json` (the payload itself is JSON).

**Exit codes:** `0` success, `1` error.

## `sf debug-run`

Write a capped, redacted post-mortem JSON bundle for a run (manifest, stage events, verification evidence, stream-log tails, and related debug fields).

```bash
sf debug-run <runId> [--out <file>]
```

| Flag | Description |
|------|-------------|
| `<runId>` | Run id (required) |
| `--out` | Write JSON to a file under cwd (stdout when omitted). Same path rules as `sf export-run`. |

Output is UTF-8 JSON (not a `.tgz`). Does not take `--json`.

**Exit codes:** `0` success, `1` error.

## `sf backup`

Consistent live snapshot of the durable store (`VACUUM INTO`), written under `$STAGEFLOW_HOME/backups/` by default. Default archives include provider credentials (mode `0600`) and must be treated as secrets. See [Docker and self-hosting](docker.md).

```bash
sf backup [--out <file>] [--db-only] [--no-credentials] [--include-a2a-artifacts] [--json]
```

| Flag | Description |
|------|-------------|
| `--out` | Destination path (refuses `$STAGEFLOW_HOME/worktrees/` and `runs/`) |
| `--db-only` | Bare DB snapshot instead of tar.gz |
| `--no-credentials` | Omit `agent/auth.json` |
| `--include-a2a-artifacts` | Include A2A artifact bytes |
| `--json` | Print metadata JSON |

HTTP: `POST /api/backup`, `GET /api/backup/<name>` (both require **drive** scope).

## `sf restore`

Whole-store restore. Host must be down (probes `GET /livez`; never calls `ensureGlobalService`). Previous `state.db` is moved aside as `*.pre-restore-<ISO>`.

```bash
sf restore <file> [--force] [--json]
```

| Flag | Description |
|------|-------------|
| `--force` | Allow major `stageflow_version` mismatch |
| `--json` | Machine-readable result |

HTTP: `POST /api/restore` with `{ "backup": "<name>" }` (drive) → `202` then drain; boot applies before opening the store.

## `sf export`

Whole-instance NDJSON export (header + one `projectRun` line per run, including non-terminal). Not a backup; restore does not accept exports. Does not take `--json` (the stream itself is NDJSON).

```bash
sf export --all [--status <status>] [--since <iso>] [--pipeline <id-or-path>] [--out <file>]
```

HTTP: `GET /api/export` (**read** scope) with the same query filters.

## `sf artifact read`

Read a run workspace artifact as UTF-8 text (same path rules as MCP `read_artifact`).

```bash
sf artifact read --run <runId> --path <relPath> [--out <file>]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--path` | Run-relative artifact path (as returned in envelope `artifacts[]`). Must be relative, with no `..`, and confined to the run workspace. Denied: any `.pi-agent` path segment, and files named `auth.json`. |
| `--out` | Write contents to a file under cwd (stdout when omitted) |

**Exit codes:** `0` success, `1` error (missing artifact, path escape, denied path).

Example:

```bash
sf artifact read --run "$RUN_ID" \
  --path stages/detect-changes/attempts/1/artifacts/changes.json
```

## `sf skills`

List and install Pi skills under `<git-root>/.pi/skills/` for pipeline stages that bind `skill:`.

```bash
sf skills list
sf skills install --from-path <dir> [--skill-name <name>]
sf skills install --from-zip <url-or-path> [--skill-name <name>] [--checksum sha256:<hex>]
```

| Subcommand | Description |
|------------|-------------|
| `list` | Installed project skills under `.pi/skills/`. Prints TSV `name\tversion\tbin/<name>.mjs` (one line per skill). An empty or missing skills dir prints no lines. |
| `install --from-path` | Copy a local skill tree into `.pi/skills/<name>/` |
| `install --from-zip` | Download or read a zip, locate skill root, copy, then run skill `doctor` |

| Flag | Description |
|------|-------------|
| `--skill-name` | Destination name (default: inferred from path or zip) |
| `--checksum` | Optional `sha256:<hex>` integrity check for zip installs |

Install runs the skill's `bin/<name>.mjs doctor` after copy. Missing or failing doctor exits `1`.

Example (CI):

```bash
sf skills install --from-zip "https://github.com/tt-a1i/archify/releases/download/v2.15.0/archify.zip" \
  --skill-name archify
```

See [CI: Skills in CI](ci.md#skills-in-ci) and [YAML catalog: skill binding](yaml-catalog.md#skill-binding). Durable install in a container is [docker exec / image bake](docker.md#cli-via-docker-exec); harnesses prefer run-scoped `start_run.skills` when that lands ([MCP decision table](mcp.md#cli-only-capabilities-decision-table)).

## `sf validate`

Validate catalog YAML (pipelines, their stages, and tasks).

```bash
sf validate [--pipeline <path>] [--task <path>] [--strict] [--json]
```

With no flags, validates **all pipelines and tasks** declared in `stageflow.yaml` (manifest-all), including each pipeline’s stages (`uses:` / `include:`).

| Flag | Description |
|------|-------------|
| `--pipeline` | Validate that pipeline file and its stages (`uses:` / `include:` transitively). Does not validate all tasks. |
| `--task` | Validate that task file only |
| `--strict` | Promote manifest warnings (`catalog.manifest_missing`, `catalog.empty_catalog`) to errors. Does not promote `catalog.legacy_yaml`, `pipeline.model_applies`, or `pipeline.route_all_gated`. Validate can pass (`ok: true`, exit 0) with warnings > 0. |
| `--json` | Machine-readable findings |

Use at most one of `--pipeline` or `--task`. The CLI rejects both.

**Exit codes:** `0` pass, `1` fail. Validate never exits `2` — no waiting state.

Does not prove provider auth or checkout paths.

Example:

```bash
sf validate --strict --json
```

## `sf doctor`

```bash
sf doctor [--json] [--pipeline <path>] [--strict]
```

Operator preflight: shared `/readyz` checks (store, home, migrations, git), plus bash, Node, credentials presence/source, TLS CA path existence, free disk, and `.mcp.json` commands on PATH. With `--pipeline`, also diffs that pipeline's `requires:` / `secrets:` / stage MCP against the toolchain manifest and curated stage env (same check as MCP `preflight` / `start_run`). `--strict` treats `unknown_version` as failure. Exits non-zero when any check is `fail`.

**Never use `sf doctor` as a container `HEALTHCHECK`.** Use `GET /livez` for liveness; doctor is a human/CI preflight tool.

## `sf graph`

Print a definition-time view of how a pipeline graph is wired, before any run. It does not require `sf ui`, does not start the operator console, and renders no HTML or mermaid — the default output is a plain, 80-column, box-drawing ASCII diagram built from the same resolved DAG that `sf validate` / `sf run` use.

```bash
sf graph --pipeline <path> [--json]
```

| Flag | Description |
|------|-------------|
| `--pipeline` | Filesystem path to the pipeline YAML (mirrors `sf validate --pipeline`). Required. |
| `--json` | Dump the resolved `ResolvedPipelineDag` as JSON instead of the terminal diagram. |

The diagram renders: stages as nodes (in dependency order), the `entry: true` stage marked with `▶`, a Clone Chain emitter's outgoing edge labeled `child~N (mode)` (one child node, not N instances), and a `{ type: loop }` as a separate `↩ loop ×N → <target>` return cue rather than a reverse DAG edge.

**Exit codes:** `0` success, `1` failure (missing/invalid `--pipeline`, unknown flag, unresolved pipeline).

Example:

```bash
sf graph --pipeline examples/feature-loop/feature-loop.pipeline.yaml
```

```text
▶ decompose   entry · clone 8 (parallel)
   │
   ▼ child~8 (parallel)
  plan
   │
   ▼
  align   clone 8 (sequential)
   │
   ▼ child~8 (sequential)
  implement
   │
   ▼
  verify
   │
   ▼
  review
   │
   ▼
  address-feedback
   ↩ loop ×2 → review   (wait_for_human)
   │
   ▼
  publish   replay_safe: false
```

`--json` prints the resolved DAG verbatim (the same object `loaded.dag` exposes internally):

```bash
sf graph --pipeline examples/feature-loop/feature-loop.pipeline.yaml --json
```

Harnesses should use MCP `describe_pipeline` / `get_run` instead of `sf graph`. In containers this command is [docker exec–only](docker.md#cli-via-docker-exec) — see [MCP — CLI-only capabilities](mcp.md#cli-only-capabilities-decision-table).

## `sf migrate-yaml` {#sf-migrate-yaml}

For catalogs that still use pre-`io` field names: convert legacy YAML (`payload_schema`, `pre_emit_checks`, `completion`, `recovery`, `clone_input_schema`) to target YAML (`io`, `verify`, `on_verify_fail`). Dry-run is the default. Does not rewrite `.stageflow` snapshots. Still reads legacy YAML when `STAGEFLOW_LEGACY_YAML=0`.

Converts **contract keys only** (`payload_schema` / `pre_emit_checks` / `completion` / `recovery` / `clone_input_schema` → `io` / `verify` / `on_verify_fail`). It does **not** rewrite `needs` / `fork` / `feedback_loop` / `route_select` / `allow_none`. Those fail load until rewritten to `route` / `entry` / `{ type: loop }`. See [Upgrading older catalogs](yaml-catalog.md#upgrading-older-catalogs) (wiring subsection).

```bash
sf migrate-yaml [path] [--root <path>] [--write] [--json] [--force]
```

| Flag | Description |
|------|-------------|
| positional path / `--root` | Pipeline, stage, task, or catalog root. Use at most one. Default: current directory. |
| `--write` | Apply planned writes atomically. Omit for dry-run. |
| `--json` | Machine-readable plan (`ok`, `write`, `planned`, `written`, `skipped`, `errors`) |
| `--force` | Overwrite files that have uncommitted git changes, or files outside a git checkout |

Dry-run lists planned writes and prints `Dry-run; pass --write to apply.` `--write` without `--force` refuses dirty git paths and paths outside a git checkout. `--write` applies the full plan or leaves the catalog unchanged. Files already on the target dialect are skipped. Mixed-key files are not rewritten; `sf validate` still errors. Idempotent: apply then apply again is a no-op.

**Exit codes:** `0` success, `1` fail.

Example:

```bash
sf migrate-yaml examples/hello-world --json
sf migrate-yaml examples/hello-world --write
```

See [CI / headless](ci.md) for `catalog.legacy_yaml` (not promoted by `--strict` this release). Not available over MCP — [docker exec / laptop only](docker.md#cli-via-docker-exec); [decision](mcp.md#cli-only-capabilities-decision-table).

## `sf ui`

Start the operator console and MCP endpoint (sessions are the MCP product default).

```bash
sf ui [--host <addr>] [--port 3847] [--no-open] [--mcp-stateless]
```

| Flag / env | Description |
|------------|-------------|
| `--host` / `STAGEFLOW_BIND` | Listen address (IPv4/IPv6 literal, `0.0.0.0`, or `::`). Default `127.0.0.1`. Flag wins over env. Rejects hostnames. |
| `--no-open` / `STAGEFLOW_NO_OPEN` | Skip opening a browser. Flag wins over env. Truthy env is any value except `""`, `0`, and `false`. |
| `--port` | TCP port (default `3847`) |
| `--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` | Disable MCP sessions (test/debug) |

Prints:

- Operator console URL (default `http://127.0.0.1:3847`; wildcard binds advertise loopback)
- MCP endpoint URL (`…/mcp`)

Opens the default browser unless `--no-open` / `STAGEFLOW_NO_OPEN` is set. Prefer **`sf mcp`** as the headless / container entrypoint; `--no-open` only makes `sf ui` usable without a browser.

Process runs until interrupted (SIGTERM/SIGINT). Catalog browse uses **seeded ∪ registered** roots under the global durable store (`$STAGEFLOW_HOME`, default `~/.stageflow/`) — Host boot cwd is not a catalog root. See [Data directory](data-directory.md) and [MCP — catalog roots](mcp.md#catalog-roots-and-project_root).

On first SIGTERM/SIGINT the Host drains: stop accepting new starts, signal active stage process groups, mark remaining stages `interrupted`, checkpoint and close SQLite, then exit. Default grace is `STAGEFLOW_SHUTDOWN_GRACE_MS=8000` (pair with compose `stop_grace_period`). Host exit codes and related env vars: [CI Host lifecycle](ci.md#host-lifecycle-sf-ui--sf-mcp).

`--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` is a test/debug escape hatch that disables MCP sessions. See [MCP](mcp.md).

**Access control.** Non-loopback binds require `STAGEFLOW_CONTROL_TOKEN` (or `_FILE`); otherwise the process refuses to start (exit `1`) before `listen`. See [MCP — access control](mcp.md#access-control).

Run **either** `sf ui` **or** `sf mcp` at a time — both bind the same default port (`3847`) on the shared global service, so running both together is a port collision, not a store conflict (they already share the same global store). `sf run` / `sf run-stage` / mutating `sf runs` verbs also auto-start this service headlessly if nothing is listening yet, so starting `sf ui` first avoids racing a later headless auto-start for the port.

## `sf mcp`

Start an MCP-only HTTP host (no operator console UI, no browser open). Preferred headless / container entrypoint.

```bash
sf mcp [--host <addr>] [--port 3847] [--mcp-stateless]
```

Same `--host` / `STAGEFLOW_BIND`, port, MCP session, and access-control rules as `sf ui` (`--no-open` is not accepted here). Prints the MCP endpoint URL (default `http://127.0.0.1:3847/mcp`). Also serves the console REST API (no static assets) and `GET /api/health`. Same global durable-root store and seeded ∪ registered catalog semantics as `sf ui`, including the same SIGTERM/SIGINT drain and Host exit codes. Sessions are the default; `--mcp-stateless` / env as above. See [MCP](mcp.md).

## `sf providers`

Manage Pi model provider authentication.

```bash
sf providers list
sf providers status [--provider <id>]
sf providers detect
sf providers source [get | set <pi_home|sf_owned>]
sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
sf providers logout <providerId>
```

| Subcommand | Description |
|------------|-------------|
| `list` | Available providers and auth capabilities |
| `status` | Configured/disconnected state per provider |
| `detect` | Pi home detection and credential binding |
| `source get` | Show credential storage mode |
| `source set pi_home\|sf_owned` | Pin storage mode |
| `login` | API key (prompt or env var) or OAuth flow |
| `logout` | Remove stored credentials for a provider |

Raw `--api-key` on the command line is **not** supported; use a prompt or `--api-key-env`.

Container Hosts should prefer boot env / `*_FILE` for API keys ([Providers](providers.md#non-interactive-host-boot-credentials)). OAuth remains [docker exec–only](docker.md#cli-via-docker-exec). See [Providers](providers.md) and [MCP — CLI-only capabilities](mcp.md#cli-only-capabilities-decision-table).

## `sf a2a`

Inbound A2A: let other agents invoke your published pipelines over JSON-RPC. See [A2A](a2a.md) for the full reference and walkthrough.

```bash
sf a2a validate [--config <path>]
sf a2a list [--config <path>]
sf a2a add-caller <id> [--config <path>] [--token-env <NAME>]
```

| Subcommand | Description |
|------------|-------------|
| `validate` | Load and check a publication config; prints the resolved publications as JSON |
| `list` | Same check, plus a reminder that a running host needs an explicit restart to pick up changes |
| `add-caller` | Register a new caller: writes its `id` and `token_env` name into `a2a.yaml` (creating the file if needed) and prints a generated token to export -- never writes a secret value to disk |

`--config` defaults to `<project-root>/a2a.yaml` when omitted -- the same file `STAGEFLOW_A2A_CONFIG` overrides if set. `sf ui` uses this same resolution to decide whether A2A is enabled at all.

Mutating / validate CLI is [docker exec–only](docker.md#cli-via-docker-exec) in containers; read whether A2A is enabled via `GET /api/a2a/status`. See [MCP — CLI-only capabilities](mcp.md#cli-only-capabilities-decision-table) and [A2A](a2a.md).

## Internal: `sf internal run-stage`

Used by the runtime to execute a single stage in a worker process. Not intended for direct use.

## Environment variables (selected)

| Variable | Purpose |
|----------|---------|
| `SF_STORE` | Must be `sqlite` (default) |
| `STAGEFLOW_MAX_CONCURRENT_RUNS` | Soft max parallel **active** runs (full slots queue via `STAGEFLOW_MAX_QUEUED`; see [CI concurrency env vars](ci.md#concurrency-env-vars)) |
| `STAGEFLOW_MAX_QUEUED` | Admission queue depth; when full, start returns `busy_capacity` |
| `STAGEFLOW_MIN_FREE_DISK_BYTES` | Free-disk admission floor (bytes or `N%`) |
| `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN` | Stage concurrency per run |
| `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` | Stage worker process cap (also in [CI / headless](ci.md)) |
| `STAGEFLOW_STAGE_EXECUTION` | Stage worker mode: `process` (default) or `inprocess` (mainly tests) |
| `STAGEFLOW_LEGACY_YAML` | Only if you still have pre-`io` catalogs: load adapter for legacy authoring keys (on by default). Set `0` to reject legacy authoring keys; [`sf migrate-yaml`](#sf-migrate-yaml) still reads legacy |
| `STAGEFLOW_MCP_STATELESS` | Disable MCP sessions (test/debug); same as `--mcp-stateless` |
| `STAGEFLOW_BIND` | Listen address for `sf ui` / `sf mcp` (overridden by `--host`) |
| `STAGEFLOW_NO_OPEN` | Skip browser open for `sf ui` (overridden by `--no-open`) |
| `STAGEFLOW_ALLOWED_HOSTS` | Comma-separated Host/Origin allow-list (loopback always allowed); reject `*` |
| `STAGEFLOW_CONTROL_TOKEN` / `_FILE` | Drive-scoped bearer token (min 32 chars); required for non-loopback bind; `caller_id` `default` |
| `STAGEFLOW_CONTROL_TOKEN_<NAME>` / `_FILE` | Named drive token (`caller_id` = lowercased `NAME`; not isolation — any drive token can access any run) |
| `STAGEFLOW_READ_TOKEN` / `_FILE` | Read-scoped bearer (`caller_id` `default`; singular — no `READ_TOKEN_<NAME>`) |
| `STAGEFLOW_READ_TOKEN` / `_FILE` | Read-scoped bearer token (GET/HEAD `/api/*` only) |
| `STAGEFLOW_REQUEST_TIMEOUT_MS` | HTTP request receive timeout (default `60000`) |
| `STAGEFLOW_MAX_CONNECTIONS` | `server.maxConnections` (default `256`) |
| `STAGEFLOW_ACTIVITY_TEXT_LIMIT` | Transcript text truncation |
| `STAGEFLOW_CURSOR_EXTENSION` | Path to Cursor Pi extension |
| `STAGEFLOW_OPERATOR_CWD` | Operator checkout root for skill resolution in CI |
| `STAGEFLOW_OPERATOR_AGENT_DIR` | Pi agent directory for user/runner skills in CI |
| `STAGEFLOW_A2A_CONFIG` | Explicit path to `a2a.yaml`, overriding auto-discovery at `<project-root>/a2a.yaml`. See [A2A](a2a.md) |
| `STAGEFLOW_SHUTDOWN_GRACE_MS` | Host SIGTERM/SIGINT drain budget (default `8000`); pair with compose `stop_grace_period` — see [CI Host lifecycle](ci.md#host-lifecycle-sf-ui--sf-mcp) |
| `STAGEFLOW_LOG_FORMAT` | Host log format: `json` or `pretty` (TTY default pretty, else json) |
| `STAGEFLOW_LOG_LEVEL` | Host log level: `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `STAGEFLOW_LOG_MAX_LINE_BYTES` | Cap stdout log line size (default `8192`) |
| `STAGEFLOW_BUILD_SHA` | Build commit SHA surfaced on health / `--version --json` (default `unknown`) |
| `STAGEFLOW_SQLITE_SYNCHRONOUS` | SQLite `synchronous` pragma (default `FULL`) |
| `STAGEFLOW_ALLOW_NETWORK_STORE` | Escape hatch to boot on NFS/CIFS (unsupported) |
| `STAGEFLOW_NO_AUTOSTART` | Disable detached Host autostart (container-safe); mutating CLI verbs fail with `autostart_disabled` |
| `STAGEFLOW_AUTO_RESUME_INTERRUPTED` | Opt-in boot auto-resume of `interrupted` stages (default off) |
| `STAGEFLOW_MAX_AUTO_RESUMES` | Cap on automatic resumes per attempt (default `3`) |

Full CI-related flags and env vars: [CI / headless](ci.md).

## See also

- [Quick start](quickstart.md) — first run walkthrough
- [Docker and self-hosting](docker.md) — backup/restore, volumes, provenance
- [CI / headless](ci.md) — GitHub Actions and `--json`
- [Providers](providers.md) — `pi_home` vs `sf_owned`
- [HITL](hitl.md) — `--skip-gates`, exit `2`, and `sf runs` answer/wait
- [MCP](mcp.md#run_stage) — `run_stage`, the tool `sf run-stage` talks to
- [A2A](a2a.md) — publish pipelines for other agents to call over JSON-RPC, plus the wildcard-access `run_stage` operation
