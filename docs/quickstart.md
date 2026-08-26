---
layout: default
title: Quickstart
---

# Quick start

This guide walks through a minimal Stageflow project: one pipeline, one stage, one task. The example is **domain-neutral** — you define what each stage does via `system_prompt` and YAML; Stageflow does not ship built-in stage types.

## Prerequisites

- **Node.js ≥ 20**
- A Pi-compatible model provider (connect after install)

```bash
npm i -g stageflow
```

## 1. Scaffold the catalog

In an empty project directory (preferably a git repo), run:

```bash
sf init
```

This creates:

| File | Purpose |
|------|---------|
| `stageflow.yaml` | Manifest — declares which directories to browse and validate |
| `pipelines/hello.pipeline.yaml` | Single inline stage pipeline |
| `tasks/hello.task.yaml` | Task file |

**Manual alternative** — same shape without `sf init`:

**`stageflow.yaml`**

```yaml
version: 1
catalog:
  pipelines:
    - pipelines
  tasks:
    - tasks
  patterns:
    pipeline: "*.pipeline.yaml"
    task: "*.task.yaml"
```

**`pipelines/hello.pipeline.yaml`**

```yaml
id: hello
stages:
  - id: hello
    system_prompt: Say hello and emit a success envelope.
    model: anthropic/claude-sonnet-4-5
```

**`tasks/hello.task.yaml`**

```yaml
id: hello
goal: Run the hello pipeline scaffold.
```

Stages are **object entries** with inline bodies or `uses:` paths — not bare string ids. See [YAML catalog](yaml-catalog.md) for the full schema.

## 2. Validate the catalog

```bash
sf validate --strict
```

With no flags, `sf validate` checks all pipelines and tasks declared in `stageflow.yaml` (manifest-all). `--strict` promotes manifest warnings (missing manifest, empty catalog) to errors.

Validation checks pipeline and stage YAML only — not task files, provider auth, or checkout paths.

## 3. Connect a provider

Either open the operator console:

```bash
sf ui
```

Go to **Settings → Providers** and connect a model, or use the CLI:

```bash
sf providers list
sf providers login anthropic --type api_key --api-key-env ANTHROPIC_API_KEY
```

See [Providers](providers.md) for `pi_home` vs `sf_owned` credential storage.

## 4. Run the pipeline

```bash
sf run --pipeline pipelines/hello.pipeline.yaml --task tasks/hello.task.yaml
```

`--pipeline` and `--task` require **filesystem paths** — there is no bare-id fallback.

Each stage runs in a **fresh Pi session**. When the stage agent finishes, it must call `emit_stage_envelope` once (see [Envelopes](envelopes.md)). On success the pipeline completes and run state is stored under **`<git-root>/.stageflow/`** regardless of which subdirectory you run from.

## 5. Operate via the console

With `sf ui` running (default `http://127.0.0.1:3847`):

- **Runs** — see active and recent runs
- **Run detail** — stage timeline, transcripts, envelope payloads
- **Start a run** — rail button or `#/new` with pipeline and task pre-filled

If a stage calls `ask_operator`, the run pauses until you reply in the console. See [Human-in-the-loop](hitl.md).

## Multi-stage pipelines

Add more stage entries to the pipeline. Use `uses:` for external stage files or inline `system_prompt` / `model`. Order with explicit `needs`:

```yaml
id: linear
stages:
  - id: clarify
    uses: ../stages/clarify.yaml
  - id: design-doc
    uses: ../stages/design-doc.yaml
    needs: clarify
```

Canonical example: [`tests/fixtures/pipelines/linear-explicit.pipeline.yaml`](../tests/fixtures/pipelines/linear-explicit.pipeline.yaml).

Parallel fan-out uses the same `needs` field — see [`tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml`](../tests/fixtures/pipelines/parallel-after-clarify.pipeline.yaml) and [YAML catalog](yaml-catalog.md).

## Headless / CI

```bash
sf validate --strict --json
sf run --pipeline pipelines/hello.pipeline.yaml --task tasks/hello.task.yaml --json
```

Exit codes: `0` success, `1` failure, `2` waiting on HITL. Details in [CI / headless](ci.md).

## See also

- [YAML catalog](yaml-catalog.md) — full schema reference
- [CLI reference](cli-reference.md) — all `sf` commands
- [Operator console](operator-console.md) — console navigation and settings
- [Envelopes](envelopes.md) — what stages must emit to advance
