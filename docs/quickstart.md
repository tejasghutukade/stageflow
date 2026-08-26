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

## 1. Create the catalog

In an empty project directory, add three files.

**`pipelines/hello.yaml`**

```yaml
id: hello
stages:
  - research
```

**`stages/research.yaml`**

```yaml
id: research
system_prompt: Summarize the task goal and list open questions.
model: anthropic/claude-sonnet-4-5
```

**`tasks/my-task.yaml`**

```yaml
id: my-task
goal: Draft a one-page brief on a topic of your choice
context: Domain-neutral hello-world run
constraints: Docs only; no implementation code
```

The stage filename must match `id` (`research.yaml` for `id: research`). Pipeline `stages[]` entries reference stage ids defined under `stages/`.

## 2. Validate the catalog

```bash
sf validate --strict
```

Validation checks pipeline and stage YAML only — not task files, provider auth, or checkout paths. See [YAML catalog](yaml-catalog.md) for the full schema.

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
sf run --task tasks/my-task.yaml --pipeline hello
```

Each stage runs in a **fresh Pi session**. When the stage agent finishes, it must call `emit_stage_envelope` once (see [Envelopes](envelopes.md)). On success the pipeline completes and run state is stored under `.stageflow/`.

## 5. Operate via the console

With `sf ui` running (default `http://127.0.0.1:3847`):

- **Runs** — see active and recent runs
- **Run detail** — stage timeline, transcripts, envelope payloads
- **Start a run** — rail button or `#/new` with pipeline and task pre-filled

If a stage calls `ask_operator`, the run pauses until you reply in the console. See [Human-in-the-loop](hitl.md).

## Multi-stage pipelines

Add more stages under `stages/` and list them in the pipeline. For explicit ordering:

```yaml
id: linear
stages:
  - id: clarify
  - id: design-doc
    needs: clarify
```

Canonical example: [`tests/fixtures/pipelines/linear-explicit.yaml`](../tests/fixtures/pipelines/linear-explicit.yaml).

Parallel fan-out uses the same `needs` field — see [`tests/fixtures/pipelines/parallel-five-fork.yaml`](../tests/fixtures/pipelines/parallel-five-fork.yaml) and [YAML catalog](yaml-catalog.md).

## Headless / CI

```bash
sf validate --strict --json
sf run --task tasks/my-task.yaml --pipeline hello --json
```

Exit codes: `0` success, `1` failure, `2` waiting on HITL. Details in [CI / headless](ci.md).

## See also

- [YAML catalog](yaml-catalog.md) — full schema reference
- [CLI reference](cli-reference.md) — all `sf` commands
- [Operator console](operator-console.md) — console navigation and settings
- [Envelopes](envelopes.md) — what stages must emit to advance
