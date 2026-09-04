---
layout: default
title: Cli Reference
---

# CLI reference

The `sf` and `stageflow` binaries expose the same commands. Run `sf --help` for the full usage string.

## Storage locations

| Path | Purpose |
|------|---------|
| `<git-root>/.stageflow/` | Run store (SQLite) and per-run workspaces when inside a git repo |
| `~/.stageflow/` | Global home — `sf_owned` auth (`agent/auth.json`), global settings |

Store backend: `SF_STORE=sqlite` only; `SF_STORE=disk` is rejected. If SQLite has no runs yet, a disk-era `.stageflow/runs` tree may be imported; if `.stageflow` is missing and `.software-factory` exists, the next store open renames it.

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

Also ensures `~/.stageflow/` exists for global config.

## `sf run`

Run a pipeline against a task file.

```bash
sf run --task <path> --pipeline <path> [--checkout <path>] [--json] [--include stages] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]
```

| Flag | Description |
|------|-------------|
| `--task` | Path to a task YAML file (required) |
| `--pipeline` | Filesystem path to a pipeline YAML file (required) |
| `--checkout` | Override task `checkout` with a working tree path |
| `--json` | Print one JSON document to stdout |
| `--include stages` | With `--json`, append `stages[]` run projection (requires `--json`) |
| `--skip-gates` | Fail the stage instead of waiting on HITL (see [HITL](hitl.md)) |
| `--git-sha` | Record git SHA on the run (CI identity) |
| `--ci-pr-url` | Record PR URL on the run |
| `--ci-job-url` | Record CI job URL on the run |
| `--operator-cwd` | Operator checkout root for skill resolution (default: process cwd) |
| `--operator-agent-dir` | Pi agent directory for user/runner skills (default: Pi `getAgentDir()`) |

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | Pipeline succeeded |
| `1` | Failed (stage error, validation error, busy start, or `--skip-gates` on HITL) |
| `2` | Pipeline waiting on operator input |

**JSON outcomes** (`--json`):

| `outcome` | `ok` | `runId` | exit |
|-----------|------|---------|------|
| `succeeded` | `true` | present | `0` |
| `failed` | `false` | present (omit if start never created a run) | `1` |
| `waiting` | `false` | present | `2` |
| `busy` | `false` | omit | `1` |

Busy codes: `busy_capacity` (concurrency limit), `busy_checkout` (same checkout leased).

Validation failure during `sf run --json` prints **validate-shaped** JSON (`ok`, `scope`, `checks`, `findings`…) with **no** `outcome` / `runId` (exit `1`). See [CI / headless](ci.md#json-stdout).

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

Each `stages[]` item is a `StageProjection` (snake_case): `stage_id`, `status`, `envelope`, `artifacts`, and optional `last_at`, `pending_prompt`. CLI completion JSON does **not** include `pipeline_track` (that field is on `sf export-run` and MCP `get_run`).

`--include stages` without `--json` exits `1`. See [CI / headless](ci.md#including-stage-projections).

## `sf runs`

Inspect and control existing stored runs (in-progress, parked, or terminal). These verbs are not a 1:1 MCP tool list and they do not list pipelines or tasks. `sf run` stays the blocking start command.

```bash
sf runs list [--status created|running|succeeded|failed] [--since <iso>] [--pipeline <id-or-path>] [--json]
sf runs show --run <runId> [--from <sf-run.json>] [--json]
sf runs verify --run <runId> --stage <stageId> [--json]
sf runs recover --run <runId> --stage <stageId> [--guidance <text>] [--stop] [--json]
sf runs waiting [--run <runId>] [--json]
sf runs wait --run <runId> [--from <sf-run.json>] [--until any|waiting|terminal] [--timeout-ms <n>] [--json]
sf runs answer --run <runId> --stage <stageId> [--answer '<json>'] [--json]
sf runs retry --run <runId> --stage <stageId> [--json]
sf runs abandon --run <runId> --stage <stageId> [--json]
sf runs rerun --run <runId> [--json]
```

| Subcommand | Role |
|------------|------|
| `list` | Stored runs (same filters as MCP `list_runs`) |
| `show` | Live `projectRun` for any run status (not the `export-run` completeness gate) |
| `verify` | Completion-check attempts, verification dispositions, and evidence for one stage |
| `recover` | Explicitly retry or stop a manual-recovery stage |
| `waiting` | Waiting gates with `pending_prompt` |
| `wait` | Block until waiting, terminal, or timeout |
| `answer` | Submit an `AskOperatorAnswer` for a parked stage |
| `retry` | Retry a failed stage; process waits until waiting or terminal |
| `abandon` | Mark a running stage abandoned |
| `rerun` | Start a new run from a stored run; process waits until waiting or terminal |

`--from` is accepted on `show` and `wait` only (reads `runId` from a prior `sf run --json` file). `--answer` is `answer` only.

### Read vs mutate

| Kind | Verbs | Host up |
|------|-------|---------|
| Read | `list`, `show`, `verify`, `waiting`, `wait` | Allowed |
| Mutate | `answer`, `retry`, `recover`, `abandon`, `rerun` | Refused |

Mutating verbs probe `GET http://127.0.0.1:3847/api/health` (1500 ms). HTTP 200 with parseable JSON → exit `1` without opening a mutating writer. This is not a single-writer lock: a host on another port (`sf ui --port 4000`) and a live blocking `sf run` are undetected second writers. Reads still work while a host is up.

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

Do not treat `answer` `{ "ok": true }` as terminal — call `sf runs wait` / `waiting` for the next state. Do not reuse `sf run` exit `2` for a completed `wait` that woke on waiting.

**Retry / rerun / abandon:**

| Verb | `--json` shape | Exit |
|------|----------------|------|
| `retry`, `rerun` | `sf run` completion JSON (`ok`, `outcome`, `runId`, …) | `0` succeeded, `1` failed/busy, `2` waiting |
| `abandon` | `{ "ok", "runId", "stageId" }` | `0` success, `1` error |

### `sf runs list`

| Flag | Description |
|------|-------------|
| `--status` | `created` \| `running` \| `succeeded` \| `failed` |
| `--since` | ISO timestamp; keep runs with `created_at >= since` |
| `--pipeline` | Match `pipeline_id` or `pipeline_path` |
| `--json` | Pretty-printed `{ "runs": [ … ] }` |

### `sf runs show`

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--from` | Read `runId` from a prior `sf run --json` output file |
| `--json` | Pretty-printed `projectRun` |

Works for in-progress and parked runs. `sf export-run` still requires `succeeded` or `failed`.

### `sf runs verify`

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--stage` | Stage id (required) |
| `--json` | Attempt-scoped verification dispositions, checks, and stored evidence |

Use this to see whether verification ran, why a completion check failed, and what an
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

Only a stage with `recovery.mode: manual` that failed completion verification is
eligible. A recovery retry starts a fresh attempt; a stop is terminal for that stage
in this run.

### `sf runs waiting`

| Flag | Description |
|------|-------------|
| `--run` | Limit to one run (omit to scan all) |
| `--json` | Pretty-printed `{ "waiting": [ … ] }` (MCP `list_waiting` fields, including `pending_prompt`) |

### `sf runs wait`

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--from` | Read `runId` from a prior `sf run --json` output file |
| `--until` | `any` (default), `waiting`, or `terminal` |
| `--timeout-ms` | Wait budget in ms. Default `60000`. Must be in `(0, 240000]`. |
| `--json` | Pretty-printed waitRun result |

`reason` is `waiting` \| `terminal` \| `timeout` \| `already`. Timeout is success (`ok: true`, exit `0`); the run is unchanged. Abort cancels only the wait, not the run.

Host-down park-and-answer:

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

### `sf runs retry` / `abandon` / `rerun`

Human/API parity for the remaining control verbs. Waiting stages are not retryable or abandonable. `retry` and `rerun` block in-process until waiting or terminal (same `0` / `1` / `2` as `sf run`). MCP `{ "runId" }` fire-and-forget is not the CLI contract.

## `sf envelope get`

Read a stage envelope or CI handoff JSON from the run store.

```bash
sf envelope get --run <runId> --stage <stageId> [--json] [--from <sf-run.json>] [--detect-stage <id>] [--format envelope|handoff]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--stage` | Stage id to read (required). After clonable fan-out this is the instance id (`work~1`), not the catalog id; run-once stays the catalog id. See [YAML catalog — instance ids](yaml-catalog.md#clonable-instance-ids). |
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
| `--out` | Write JSON to a file under the current working directory (stdout when omitted). Path must stay under cwd (no `..`). |

Writes the full `projectRun` projection (includes `pipeline_track` and waiting fields). The run must be complete (`succeeded` or `failed`). In-progress runs exit `1`.

**Exit codes:** `0` success, `1` error.

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

See [CI: Skills in CI](ci.md#skills-in-ci) and [YAML catalog: skill binding](yaml-catalog.md#skill-binding).

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
| `--strict` | Promote manifest warnings (`catalog.manifest_missing`, `catalog.empty_catalog`) to errors |
| `--json` | Machine-readable findings |

Use at most one of `--pipeline` or `--task`. The CLI rejects both.

**Exit codes:** `0` pass, `1` fail. Validate never exits `2` — no waiting state.

Does not prove provider auth or checkout paths.

Example:

```bash
sf validate --strict --json
```

## `sf ui`

Start the operator console and MCP endpoint (sessions are the MCP product default).

```bash
sf ui [--port 3847] [--mcp-stateless]
```

Prints:

- Operator console URL (default `http://127.0.0.1:3847`)
- MCP endpoint URL (`…/mcp`)

Opens the default browser. Process runs until interrupted. The run store resolves to `<git-root>/.stageflow/` even when started from a subdirectory.

`--mcp-stateless` / `STAGEFLOW_MCP_STATELESS=1` is a test/debug escape hatch that disables MCP sessions. See [MCP](mcp.md).

Run **either** `sf ui` **or** `sf mcp` for a project — not both against the same store.

## `sf mcp`

Start an MCP-only HTTP host (no operator console UI, no browser open).

```bash
sf mcp [--port 3847] [--mcp-stateless]
```

Prints the MCP endpoint URL (default `http://127.0.0.1:3847/mcp`). Also serves minimal `GET /api/health`. Same git-root / `.stageflow/` semantics as `sf ui`. Sessions are the default; `--mcp-stateless` / env as above. See [MCP](mcp.md).

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

See [Providers](providers.md).

## Internal: `sf internal run-stage`

Used by the runtime to execute a single stage in a worker process. Not intended for direct use.

## Environment variables (selected)

| Variable | Purpose |
|----------|---------|
| `SF_STORE` | Must be `sqlite` (default) |
| `STAGEFLOW_MAX_CONCURRENT_RUNS` | Soft max parallel runs |
| `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN` | Stage concurrency per run |
| `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` | Stage worker process cap (also in [CI / headless](ci.md)) |
| `STAGEFLOW_STAGE_EXECUTION` | Stage worker mode: `process` (default) or `inprocess` (mainly tests) |
| `STAGEFLOW_MCP_STATELESS` | Disable MCP sessions (test/debug); same as `--mcp-stateless` |
| `STAGEFLOW_ACTIVITY_TEXT_LIMIT` | Transcript text truncation |
| `STAGEFLOW_CURSOR_EXTENSION` | Path to Cursor Pi extension |
| `STAGEFLOW_OPERATOR_CWD` | Operator checkout root for skill resolution in CI |
| `STAGEFLOW_OPERATOR_AGENT_DIR` | Pi agent directory for user/runner skills in CI |

Full CI-related flags and env vars: [CI / headless](ci.md).

## See also

- [Quick start](quickstart.md) — first run walkthrough
- [CI / headless](ci.md) — GitHub Actions and `--json`
- [Providers](providers.md) — `pi_home` vs `sf_owned`
- [HITL](hitl.md) — `--skip-gates`, exit `2`, and `sf runs` answer/wait
