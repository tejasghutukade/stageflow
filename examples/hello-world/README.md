# hello-world

Minimal single-stage pipeline. Domain-neutral — the stage id and prompts are yours to define.

## What this demonstrates

- **`task.input` ↔ entry `io.input.schema`** — `my-task.task.yaml` supplies a structured `input` object; the entry stage (`research.yaml`) declares matching `io.input.schema`.
- **Unmet entry input** — if the entry stage declares `io.input` and the task omits `input`, `sf validate` of each file alone still succeeds; start-run / `preparePipeline` warn with `task.entry_input_unmet` and continue (existing product behavior).

This catalog uses `io` only (no `verify` / `on_verify_fail`). For upgrading older field names, see [YAML catalog — Dual-read](../../docs/yaml-catalog.md#dual-read-this-release).

## Prerequisites

- Node.js ≥ 20, Stageflow installed (`npm i -g stageflow`)
- A Pi-compatible provider connected via `sf ui` or `sf providers login`

## Commands

From the **repository git root**:

```bash
sf validate --pipeline examples/hello-world/hello.pipeline.yaml --strict
sf run \
  --pipeline examples/hello-world/hello.pipeline.yaml \
  --task examples/hello-world/my-task.task.yaml
```

Use `sf ui` (from any subdirectory) to watch the run and inspect the stage envelope.
