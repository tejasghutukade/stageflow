# CLI reference

The `sf` and `stageflow` binaries expose the same commands. Run `sf --help` for the full usage string.

Runtime state lives under **`.stageflow/`** (SQLite store + per-run workspaces). Store backend: `SF_STORE=sqlite` only; `SF_STORE=disk` is rejected.

## Global

```bash
sf --help
```

## `sf run`

Run a pipeline against a task file.

```bash
sf run --task <path> --pipeline <name-or-path> [options]
```

| Flag | Description |
|------|-------------|
| `--task` | Path to a task YAML file (required) |
| `--pipeline` | Pipeline id or path (required) |
| `--checkout` | Override task `checkout` with a working tree path |
| `--json` | Print one JSON document to stdout |
| `--skip-gates` | Fail the stage instead of waiting on HITL (see [HITL](hitl.md)) |
| `--git-sha` | Record git SHA on the run (CI identity) |
| `--ci-pr-url` | Record PR URL on the run |
| `--ci-job-url` | Record CI job URL on the run |

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
sf run --task tasks/sample.yaml --pipeline single --json
```

## `sf validate`

Validate pipeline and stage YAML in the current directory.

```bash
sf validate [--pipeline <name-or-path>] [--strict] [--json]
```

| Flag | Description |
|------|-------------|
| `--pipeline` | Validate one pipeline (default: full catalog) |
| `--strict` | Treat orphan stages as errors |
| `--json` | Machine-readable findings |

**Exit codes:** `0` pass, `1` fail. Validate never exits `2` — no waiting state.

Scope: pipeline and stage YAML only. Does not prove provider auth, task shape, or checkout paths.

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

Opens the default browser. Process runs until interrupted. See [Operator console](operator-console.md) and [MCP](mcp.md).

## `sf providers`

Manage Pi model provider authentication. All subcommands run from the project directory (factory cwd).

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

Full CI-related flags and env vars: [CI / headless](ci.md).

## See also

- [Quick start](quickstart.md) — first run walkthrough
- [CI / headless](ci.md) — GitHub Actions and `--json`
- [Providers](providers.md) — `pi_home` vs `sf_owned`
- [HITL](hitl.md) — `--skip-gates` and exit `2`
