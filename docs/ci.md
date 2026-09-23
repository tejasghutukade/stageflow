---
layout: default
title: Ci
---

# CI / headless

Stageflow is designed to run the same YAML catalog locally, in the operator console, and in CI. The **guest actor in CI is the CLI** — `sf ui` and MCP are not required in the job.

Run validate and pipeline commands from the **repository root** (`$GITHUB_WORKSPACE`) with path arguments:

```bash
sf validate --strict --json
sf run --task examples/hello-world/my-task.task.yaml --pipeline examples/hello-world/hello.pipeline.yaml --json
```

## Validate in CI

Check catalog shape before running agents:

```bash
sf validate --strict --json
```

| Exit | Meaning |
|------|---------|
| `0` | No errors |
| `1` | Validation errors (warnings alone pass unless `--strict` promotes manifest warnings) |

With no flags, `sf validate` validates **all pipelines and tasks** declared in `stageflow.yaml` (manifest-all), including each pipeline’s stages. `--pipeline` validates that pipeline and its stages (`uses:` / `include:`), not all tasks. `--task` validates that task file. The CLI rejects both `--pipeline` and `--task`. `--strict` promotes `catalog.manifest_missing` and `catalog.empty_catalog` warnings to errors. `--strict` does not promote `catalog.legacy_yaml` (only relevant if you still have pre-`io` catalogs), `pipeline.model_applies`, or `pipeline.route_all_gated`. `catalog.legacy_yaml` names replacement fields (for example `payload_schema` → `io.output.schema`). Convert older **contract** keys with `sf migrate-yaml` (dry-run default; `--write` to apply). That command does not rewrite `needs` / `fork` / `feedback_loop` — see [Upgrading older catalogs](yaml-catalog.md#upgrading-older-catalogs). Finding codes are additive.

Does not prove provider auth or checkout paths.

JSON output includes `ok`, `scope`, `checks`, `summary`, and `findings[]` with `severity`, `code`, `file`, `message`, `category`. The CLI remaps each finding’s `path` to `file`; MCP `validate` keeps `path`.

## Run in CI

```bash
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
sf run --task examples/hello-world/my-task.task.yaml --pipeline examples/hello-world/hello.pipeline.yaml --json
```

Provider login stores credentials in the job environment (prefer `--api-key-env` over prompts).

### Exit codes

| Code | `outcome` | When |
|------|-----------|------|
| `0` | `succeeded` | Pipeline completed |
| `1` | `failed`, `cancelled`, or `busy` | Stage error, validation at start, operator/API cancel, concurrency or queue conflict |
| `2` | `waiting` | Stage blocked on HITL |

A listed successor skipped by Route `if` (or skip-cascade from a skipped parent) is `skipped`, not `failed`; a run where all non-failed stages are `succeeded` or `skipped` exits `0`. A failed parent still fails the run: a [generic fan-in](yaml-catalog.md#generic-fan-in) Join stays pending even if that parent's `on` lists `failed`. Skipped siblings do not block a Join that has a succeeded parent.

For unattended CI, either use pipelines **without** `ask_operator`, or pass **`--skip-gates`** (fails the stage with exit `1` instead of parking). See [HITL](hitl.md). The CI guest uses `sf run --json` / `--skip-gates` only — it does not wait or answer with `sf runs`. Outside CI, humans and agents can continue a parked run with [`sf runs`](cli-reference.md#sf-runs).

Blocking `sf run` treats `cancelled` as terminal (exit `1`) the same way as `failed` — a cancel during the poll returns promptly instead of hanging.

### JSON stdout

One document per invocation with `--json`:

**Success:**

```json
{
  "ok": true,
  "outcome": "succeeded",
  "runId": "…",
  "runDir": ".stageflow/runs/…"
}
```

When start-run pairing produces warnings (for example `pipeline.model_applies`), the same document includes optional `findings[]` (`severity`, `code`, `file`, `message`, `category` — `path` remapped to `file`, matching `sf validate --json`). Warnings do not fail the run (`ok` / `outcome` / exit stay as today). Omitted `task.input` is treated as `{}` against each entry `io.input.schema`; a mismatch fails start-run as validate-shaped JSON (`task.invalid_shape`).

When concurrency slots are full but the admission queue still has room, start succeeds and the Host may admit the run as `queued`. Blocking `sf run` prints `queued at position N` on stderr, then waits until the run leaves the queue and reaches a terminal outcome. MCP `start_run` returns `{ "runId", "queued": true, "queuePosition" }` for that case — still a success, just slower to start.

**Waiting:**

```json
{
  "ok": false,
  "outcome": "waiting",
  "runId": "…",
  "runDir": "…"
}
```

**Failed (run created):**

```json
{
  "ok": false,
  "outcome": "failed",
  "runId": "…",
  "runDir": "…",
  "reason": "…"
}
```

**Cancelled** (run created, then cancelled — exit `1`):

```json
{
  "ok": false,
  "outcome": "cancelled",
  "runId": "…",
  "runDir": "…",
  "reason": "…"
}
```

`reason` is the cancel text stored as `cancel_reason` when present. Cancel signals live stage workers via process-group kill (SIGTERM, then SIGKILL escalation) so agent grandchildren are included in the tree.

**Busy** (`outcome: "busy"`, no `runId`):

```json
{
  "ok": false,
  "outcome": "busy",
  "code": "busy_capacity",
  "reason": "…",
  "activeCount": 3,
  "maxConcurrent": 3,
  "activeRunIds": ["…"]
}
```

`code` is `busy_capacity`, `busy_checkout`, or `busy_caller_quota`. **`busy_capacity` means the admission queue is full** (or concurrency is full when queuing cannot accept the run) — not merely “active slots are full,” which now queues instead. Capacity fields include `activeCount` / `maxConcurrent` / `activeRunIds`; checkout conflict includes `conflictingRunId` / `conflictingCheckout`. `busy_checkout` never queues. `busy_caller_quota` is for named-caller concurrency limits (queues while the global queue has room; rejects when that queue is full) — distinct from per-project `busy_capacity` rejects.

**Insufficient disk** (`outcome: "failed"`, no `runId`, exit `1`):

```json
{
  "ok": false,
  "outcome": "failed",
  "code": "insufficient_disk",
  "reason": "…",
  "freeBytes": 12000000,
  "minFreeBytes": 50000000
}
```

Distinct from `busy_capacity`. The run is not queued. The same floor is re-checked when a queued run would dequeue; a dequeue-time miss cancels that queued row with `cancel_reason: "insufficient_disk"`.

**Start failed without a run** (`outcome: "failed"`, no `runId`):

```json
{
  "ok": false,
  "outcome": "failed",
  "reason": "…"
}
```

Optional `code` when the start failure reports one.

**Validation failure during `sf run --json`:** stdout is **validate-shaped** JSON (`ok`, `scope`, `checks`, `findings`…) with **no** `outcome` / `runId`. Exit `1`. Distinct from `outcome: "failed"`.

`ok` is `true` only for `succeeded`.

### Including stage projections {#including-stage-projections}

Pass **`--include stages`** with **`--json`** to append a `stages[]` array to the completion document. Each item is a `StageProjection` (snake_case): `stage_id`, `status`, `envelope`, `artifacts`, and optional `last_at`, `pending_prompt`. That `--include stages` schema is unchanged for diamond runs — it does not add `pipeline_track` or join-input fields. The multi-edge graph (a diamond join has two inbound `pipeline_track` edges; `blocked_by` lists unresolved parents) is on `sf runs show --json`, MCP `get_run`, and `sf export-run`. `--include stages` without `--json` exits `1`.

```bash
sf run --task examples/hello-world/my-task.task.yaml \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --json --include stages > sf-run.json
```

On success the document adds `stages[]` alongside the usual root keys (`ok`, `outcome`, `runId`, `runDir`). Without `--include`, the baseline shape is unchanged — no `stages` key.

If the run store cannot be read after completion (for example, a locked database), the command exits non-zero and prints an error to stderr instead of emitting JSON without `stages[]`.

Run records store optional **`pipeline_path`** and **`task_path`** catalog locators (for resume and triage). These appear on MCP `get_run` and console run detail — not in CLI `--json` stdout.

### Handoff envelope extraction {#handoff-envelope-extraction}

After `sf run --json`, read stage deliverables without querying SQLite:

```bash
sf envelope get --from sf-run.json --stage author-diagrams \
  --detect-stage detect-changes --format handoff --json > envelope.json
```

| `--format` | Output |
|------------|--------|
| `envelope` (default) | Raw stage envelope JSON |
| `handoff` | CI deliverables shape: `{ skipped: true }` when detect emits `fork_choice: []`, otherwise `{ skipped: false, runId, runDir, stageId, diagrams: [{ diagram_type, spec_path, summary }] }` with absolute `spec_path` values |

Use `--from sf-run.json` to read `runId` and `runDir` from a prior `sf run --json` output file. `--detect-stage` is optional; when set, an empty `fork_choice` on that stage emits `{ skipped: true }` and exits `0`.

### Composite action

This repo ships [`.github/actions/sf-run`](../.github/actions/sf-run) for **same-repo** workflows only. It invokes `node dist/cli.js` (the **repo must be built** with `npm run build`), not the global `sf` from `npm i -g stageflow` used in the [recipe below](#github-actions-recipe). It runs `sf run --json --include stages`, optionally extracts a handoff envelope, and optionally writes `run-export.json`.

The action propagates any non-zero exit from `sf run`, including exit `2` (HITL waiting fails the GHA step). For unattended HITL pipelines pass `extra-args: --skip-gates`.

```yaml
- id: sf-run
  uses: ./.github/actions/sf-run
  with:
    pipeline: examples/archify-on-pr/archify-on-pr.pipeline.yaml
    task: examples/archify-on-pr/archify-on-pr.task.yaml
    checkout: ${{ github.workspace }}
    extra-args: --skip-gates --git-sha ${{ github.sha }}
    detect-stage: detect-changes
    stage: author-diagrams
```

| Input | Description |
|-------|-------------|
| `pipeline`, `task` | Required pipeline and task YAML paths |
| `checkout` | Checkout path for `sf run` (default: `${{ github.workspace }}`) |
| `extra-args` | Additional `sf run` flags |
| `detect-stage` | Stage id for fork skip detection in handoff extraction |
| `stage` | Stage id for handoff extraction (writes `envelope.json`) |
| `export-run` | Set to `true` to write `run-export.json` via `sf export-run` |

| Output | Description |
|--------|-------------|
| `run-id`, `run-dir` | From `sf-run.json` |
| `skipped` | `"true"` when handoff JSON has `skipped: true` |
| `envelope-path` | Path to `envelope.json` when `stage` is set |
| `run-export-path` | Path to `run-export.json` when `export-run` is `true` |

## CI identity metadata

Optional flags on `sf run` (auto-detected on GitHub Actions when omitted):

| Flag / env | Description |
|------------|-------------|
| `--git-sha` / `GITHUB_SHA` | Git commit |
| `--ci-pr-url` | Pull request URL (derived from `GITHUB_REF` when possible) |
| `--ci-job-url` | Job URL (derived from `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, etc.) |

Recorded on the run for operator triage in the console.

## Skills in CI {#skills-in-ci}

Stages can reference installed skills via the `skill:` field in stage YAML. Skills resolve from the **operator checkout** `{ cwd, agentDir }`:

- **Project skills:** commit under `.pi/skills/<name>/SKILL.md` in the project git root. Run `sf run` from the repo (or pass `--operator-cwd <path>` / set `STAGEFLOW_OPERATOR_CWD`).
- **User/runner skills:** install under the Pi agent directory (`~/.pi/agent/skills/<name>/SKILL.md`), or pass `--operator-agent-dir <path>` / set `STAGEFLOW_OPERATOR_AGENT_DIR` to point at a Pi agent dir that contains a `skills/` subtree.

The guest CLI defaults to `{ cwd: process.cwd(), agentDir: getAgentDir() }`. Override when the job checkout is not the skill tree root or when skills live in a shared agent dir on the runner.

## Extensions in CI

Only provider-level hooks are supported today — for example `STAGEFLOW_CURSOR_EXTENSION` for Cursor-backed models. Per-stage extension YAML in the catalog is not supported in headless CI yet.

## GitHub Actions recipe

```yaml
name: Stageflow

on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm i -g stageflow
      - run: sf validate --strict --json

  run-pipeline:
    runs-on: ubuntu-latest
    needs: validate
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm i -g stageflow
      - name: Provider auth
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
      - name: Run pipeline
        run: sf run --task examples/hello-world/my-task.task.yaml --pipeline examples/hello-world/hello.pipeline.yaml --json --skip-gates
        # When skills live outside the repo checkout, add:
        # --operator-cwd path/to/checkout
```

Adjust task, pipeline, and secrets for your project. Dogfood release automation lives in [`examples/github-release/`](../examples/github-release/). To rewrite notes on an already-published GitHub Release, run **Repair GitHub Release notes** from the Actions tab.

## Concurrency env vars

| Variable | Effect |
|----------|--------|
| `STAGEFLOW_MAX_CONCURRENT_RUNS` | Soft cap on parallel **active** runs; when full, new starts enter the admission queue instead of failing immediately |
| `STAGEFLOW_MAX_QUEUED` | Cap on persisted `queued` runs (default `32`). When this queue is also full, start returns `busy_capacity` |
| `STAGEFLOW_MIN_FREE_DISK_BYTES` | Free-space floor for start and dequeue (integer bytes or `N%` of the durable-root filesystem). Below the floor → `insufficient_disk` (not queued) |
| `STAGEFLOW_DISK_WARN_BYTES` | Boot warn threshold for free space (bytes or `N%`); one-shot log at Host start, not an admission gate |
| `STAGEFLOW_GC_INTERVAL_MS` | Periodic retention sweep interval (default 1h); `0` disables. First sweep fires one interval after boot |
| `STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES` | Artifact size above which SLIM may reclaim (default 1 MiB) |
| `STAGEFLOW_BARE_CACHE_TTL_MS` | Bare clone cache TTL before eviction eligibility (default 30d) |
| `STAGEFLOW_SLIM_SUCCEEDED_MS` | SLIM window for `succeeded` runs (default 3d) |
| `STAGEFLOW_PURGE_SUCCEEDED_MS` | PURGE window for `succeeded` runs (default 30d) |
| `STAGEFLOW_SLIM_FAILED_MS` | SLIM window for `failed` runs (default 14d) |
| `STAGEFLOW_PURGE_FAILED_MS` | PURGE window for `failed` runs (default 90d) |
| `STAGEFLOW_SLIM_CANCELLED_MS` | SLIM window for `cancelled` runs (default 1d) |
| `STAGEFLOW_PURGE_CANCELLED_MS` | PURGE window for `cancelled` runs (default 14d) |
| `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN` | Parallel stages within one run |
| `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` | Stage worker process cap |
| `STAGEFLOW_OPERATOR_CWD` | Operator checkout root for skill resolution (see [Skills in CI](#skills-in-ci)) |
| `STAGEFLOW_OPERATOR_AGENT_DIR` | Pi agent directory for user/runner skills |

## Host lifecycle (sf ui / sf mcp)

`sf run`'s exit codes `0` / `1` / `2` above are unchanged. The long-lived Host (`sf ui` / `sf mcp`) uses a separate exit table.

### Host exit codes

| Code | Meaning |
|------|---------|
| `0` | Clean shutdown. Signal received, drain completed within the grace period, stages finished or recorded `interrupted`, SQLite checkpointed and closed |
| `1` | Unhandled crash; state may not be checkpointed |
| `2` | Reserved — never used by the Host (`sf run` uses `2` for waiting) |
| `3` | Refused to start: invalid configuration (bad bind, malformed env, unwritable `$STAGEFLOW_HOME`) |
| `4` | Refused to start: on-disk store schema is newer than this binary |
| `5` | Forced shutdown. Grace period expired; workers were SIGKILLed. `interrupted` records were attempted and may be incomplete |
| `6` | Escalated shutdown. A second SIGTERM/SIGINT arrived during the drain |

### Host env vars

| Variable | Effect |
|----------|--------|
| `STAGEFLOW_SHUTDOWN_GRACE_MS` | SIGTERM/SIGINT drain budget in ms (default `8000`). Workers get grace − 2000 ms; the final 2 s are reserved for `interrupted` writes and WAL close. Pair with compose `stop_grace_period` — raising grace without raising `stop_grace_period` truncates the drain under `docker stop`'s default 10 s window |
| `STAGEFLOW_LOG_FORMAT` | `json` or `pretty`. Default: `pretty` on a TTY, `json` otherwise (container / piped logs) |
| `STAGEFLOW_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `STAGEFLOW_NO_AUTOSTART` | When set (truthy, not `0`/`false`), CLI verbs that would spawn a detached Host refuse with `autostart_disabled` instead — required for container images where the entrypoint already runs the Host |
| `STAGEFLOW_AUTO_RESUME_INTERRUPTED` | Opt-in boot auto-resume of `interrupted` stages (default off). Reconciliation still writes `interrupted` unconditionally |
| `STAGEFLOW_MAX_AUTO_RESUMES` | Cap on automatic resumes per stage attempt (default `3`). Past the cap the stage stays `interrupted` with reason `auto_resume_capped`; explicit `resume_stage` / `sf runs resume` still works and resets the counter |

## State in CI

Runs write under the **global durable root** (`$STAGEFLOW_HOME`, default `~/.stageflow/` on the runner). Set `STAGEFLOW_HOME` to a job-local path and cache or artifact that directory if you need post-job inspection; ephemeral runners can discard it. See [Data directory](data-directory.md).

## PR diagrams (Archify) {#pr-diagrams-archify}

This repo dogfoods [`examples/archify-on-pr/`](../examples/archify-on-pr/) in
[`.github/workflows/archify-pr-diagrams.yml`](../.github/workflows/archify-pr-diagrams.yml).

The workflow is **manually triggered** via `workflow_dispatch` (not automatic on
every PR). Inputs: `pr_number` and/or `head_ref` (provide one), plus optional
`base_ref` (default `main`). Sticky PR comments run only when `pr_number` is set.

Provider auth uses **OpenRouter** (`OPENROUTER_API_KEY`), not OpenAI.
`scripts/prepare-ci-context.sh` writes full `changed_files`, filtered
`relevant_files`, and deterministic `diagram_types` / `change_summary` /
`expected_fork_choice` from path rules; when the relevant set is empty, GHA
skips the pipeline early. **detect-changes** copies that context into
`changes.json` and the envelope (no type-selection heuristics) and sets
`author_diagrams` true iff `diagram_types` is non-empty. Pipeline
completion checks the handoff against ci-context via
`scripts/validate-detect-envelope.mjs`. Route `if` on `author_diagrams`
skips **author-diagrams** when no types were selected; otherwise that
stage writes `{type}.spec.json` per type in one session. The workflow uses
[`.github/actions/sf-run`](../.github/actions/sf-run) with `export-run: true`,
then runs Archify `deliver` for each spec via `scripts/deliver-diagrams.sh`,
uploads per-type HTML (unzipped for in-browser viewing) plus a `diagrams/`
bundle, and updates a sticky PR comment when applicable. Skill provisioning uses
`sf skills install --from-zip`; agents do not install Archify or post comments.

When `relevant_files` is empty, GHA skips deliver, upload, and comment before
`sf run`. Fork PRs cannot receive bot comments with the default token; see the
example README.

## See also

- [CLI reference](cli-reference.md) — full flag list
- [HITL](hitl.md) — exit `2` and `--skip-gates`
- [Providers](providers.md) — non-interactive login
- [MCP](mcp.md) — not required for CI
