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

Store backend: `SF_STORE=sqlite` only; `SF_STORE=disk` is rejected.

## Global

```bash
sf --help
```

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
sf run --task <path> --pipeline <path> [--checkout <path>] [--json] [--skip-gates] [--git-sha <sha>] [--ci-pr-url <url>] [--ci-job-url <url>] [--operator-cwd <path>] [--operator-agent-dir <path>]
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

`--include stages` without `--json` exits `1`. See [CI / headless](ci.md#including-stage-projections).

## `sf envelope get`

Read a stage envelope or CI handoff JSON from the run store.

```bash
sf envelope get --run <runId> --stage <stageId> [--json] [--from <sf-run.json>] [--detect-stage <id>] [--format envelope|handoff]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (optional when `--from` provides `runId`) |
| `--stage` | Stage id to read (required) |
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
| `--out` | Write JSON to a file under the current working directory (stdout when omitted) |

The run must be complete (`succeeded` or `failed`). In-progress runs exit `1`.

**Exit codes:** `0` success, `1` error.

## `sf artifact read`

Read a run workspace artifact file safely (path confined to the run workspace).

```bash
sf artifact read --run <runId> --path <relPath> [--out <file>]
```

| Flag | Description |
|------|-------------|
| `--run` | Run id (required) |
| `--path` | Run-relative artifact path (as returned in envelope `artifacts[]`) |
| `--out` | Write contents to a file under cwd (stdout when omitted) |

**Exit codes:** `0` success, `1` error (missing artifact, path escape).

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
| `list` | Installed project skills under `.pi/skills/` |
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

Validate pipeline and stage YAML.

```bash
sf validate [--pipeline <path>] [--task <path>] [--strict] [--json]
```

With no flags, validates all pipelines and tasks declared in `stageflow.yaml` (manifest-all).

| Flag | Description |
|------|-------------|
| `--pipeline` | Validate one pipeline file (includes `uses:` / `include:` transitively) |
| `--task` | Validate one task file |
| `--strict` | Promote manifest warnings (`catalog.manifest_missing`, `catalog.empty_catalog`) to errors |
| `--json` | Machine-readable findings |

Use at most one of `--pipeline` or `--task`.

**Exit codes:** `0` pass, `1` fail. Validate never exits `2` — no waiting state.

Scope: pipeline and stage YAML only. Does not prove provider auth, task shape beyond `--task` scope, or checkout paths.

Example:

```bash
sf validate --strict --json
```

## `sf ui`

Start the operator console and MCP endpoint.

```bash
sf ui [--port 3847]
```

Prints:

- Operator console URL (default `http://127.0.0.1:3847`)
- MCP endpoint URL (`…/mcp`)

Opens the default browser. Process runs until interrupted. The run store resolves to `<git-root>/.stageflow/` even when started from a subdirectory. See [Operator console](operator-console.md) and [MCP](mcp.md).

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
| `STAGEFLOW_STAGE_EXECUTION` | Stage worker mode (`process` default) |
| `STAGEFLOW_ACTIVITY_TEXT_LIMIT` | Transcript text truncation |
| `STAGEFLOW_CURSOR_EXTENSION` | Path to Cursor Pi extension |
| `STAGEFLOW_OPERATOR_CWD` | Operator checkout root for skill resolution in CI |
| `STAGEFLOW_OPERATOR_AGENT_DIR` | Pi agent directory for user/runner skills in CI |

Full CI-related flags and env vars: [CI / headless](ci.md).

## See also

- [Quick start](quickstart.md) — first run walkthrough
- [CI / headless](ci.md) — GitHub Actions and `--json`
- [Providers](providers.md) — `pi_home` vs `sf_owned`
- [HITL](hitl.md) — `--skip-gates` and exit `2`
