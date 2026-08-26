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

With no flags, `sf validate` validates all pipelines and tasks declared in `stageflow.yaml`. `--strict` promotes `catalog.manifest_missing` and `catalog.empty_catalog` warnings to errors.

Validate scope: **pipeline and stage YAML only**. It does not verify task files (unless `--task`), provider credentials, or checkout paths.

JSON output includes `ok`, `scope`, `summary`, and `findings[]` with `severity`, `code`, `file`, `message`.

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
| `1` | `failed` or `busy` | Stage error, validation at start, concurrency conflict |
| `2` | `waiting` | Stage blocked on HITL |

Unchosen branches in fork pipelines are `skipped`, not `failed`; a run where all non-failed stages are `succeeded` or `skipped` exits `0`.

For unattended CI, either use pipelines **without** `ask_operator`, or pass **`--skip-gates`** (fails the stage with exit `1` instead of parking). See [HITL](hitl.md).

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

**Waiting:**

```json
{
  "ok": false,
  "outcome": "waiting",
  "runId": "…",
  "runDir": "…"
}
```

**Failed:**

```json
{
  "ok": false,
  "outcome": "failed",
  "runId": "…",
  "runDir": "…",
  "reason": "…"
}
```

`ok` is `true` only for `succeeded`.

Run records store optional **`pipeline_path`** and **`task_path`** catalog locators (for resume and triage). These appear on MCP `get_run` and console run detail — not in CLI `--json` stdout.

## CI identity metadata

Optional flags on `sf run` (auto-detected on GitHub Actions when omitted):

| Flag / env | Description |
|------------|-------------|
| `--git-sha` / `GITHUB_SHA` | Git commit |
| `--ci-pr-url` | Pull request URL (derived from `GITHUB_REF` when possible) |
| `--ci-job-url` | Job URL (derived from `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, etc.) |

Recorded on the run for operator triage in the console.

## Skills in CI

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

Adjust task, pipeline, and secrets for your project. Dogfood release automation lives in [`examples/github-release/`](../examples/github-release/).

## Concurrency env vars

| Variable | Effect |
|----------|--------|
| `STAGEFLOW_MAX_CONCURRENT_RUNS` | Soft cap on parallel runs (busy exit if full) |
| `STAGEFLOW_MAX_ACTIVE_STAGES_PER_RUN` | Parallel stages within one run |
| `STAGEFLOW_MAX_ACTIVE_STAGE_PROCESSES` | Stage worker process cap |
| `STAGEFLOW_OPERATOR_CWD` | Operator checkout root for skill resolution (see [Skills in CI](#skills-in-ci)) |
| `STAGEFLOW_OPERATOR_AGENT_DIR` | Pi agent directory for user/runner skills |

## State in CI

Runs write under **`<repo>/.stageflow/`** at the git root. Cache or artifact this directory if you need post-job inspection; ephemeral runners can discard it.

## PR diagrams (Archify)

This repo dogfoods [`examples/archify-on-pr/`](../examples/archify-on-pr/) in
[`.github/workflows/archify-pr-diagrams.yml`](../.github/workflows/archify-pr-diagrams.yml).

On pull requests, Stageflow agents **detect** diagram-relevant diffs and choose
one or more Archify types (`architecture`, `workflow`, `sequence`, `dataflow`,
`lifecycle`). The **author-diagrams** stage writes `{type}.spec.json` per type.
GitHub Actions then runs Archify `deliver` for each spec, uploads the `diagrams/`
artifact, and updates a sticky PR comment listing every type with a link to the
artifact bundle. Agents do not install Archify or post comments.

When detect emits `fork_choice: []` (docs-only changes), GHA skips deliver,
upload, and comment. Fork PRs cannot receive bot comments with the default token;
see the example README.

## See also

- [CLI reference](cli-reference.md) — full flag list
- [HITL](hitl.md) — exit `2` and `--skip-gates`
- [Providers](providers.md) — non-interactive login
- [MCP](mcp.md) — not required for CI
