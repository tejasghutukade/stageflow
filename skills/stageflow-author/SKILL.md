---
name: stageflow-author
description: >-
  Turns a described structure or repeatable loop into a reusable Stageflow
  pipeline and one stage YAML per step in the project catalog. Use when a
  human explains steps, sequencing, a decision point, or a review they want
  to reuse.
compatibility: Requires the sf CLI on PATH
disable-model-invocation: true
---

# Stageflow author

Turn a structure a human can explain into one pipeline YAML file and one stage YAML file per step. `stageflow-run` owns starting a run and any throwaway task.

Talking jobs cite [`../stageflow/references/control-surface.md`](../stageflow/references/control-surface.md). Probe with [`../stageflow/scripts/detect-host.mjs`](../stageflow/scripts/detect-host.mjs) only when choosing MCP `validate` — see [`references/validate-and-report.md`](references/validate-and-report.md). Do not write a second probe.

Shape reference: [`assets/examples/linear-review/`](assets/examples/linear-review/), [`assets/examples/branch-decision/`](assets/examples/branch-decision/), [`assets/examples/non-sdlc-digest/`](assets/examples/non-sdlc-digest/).

## Provider gate

Run before any catalog write:

```
sf providers status
```

A provider counts when a row's second column is `configured`. **Done when** at least one row is `configured`. If none are, or the command fails, stop. Write nothing. Name `stageflow-setup`. Do not run `sf providers login`.

## Elicit

Ask until you can name every step, how they sequence, any decision point, and any review or sign-off. Confirm that mapped summary with the human before writing.

**Done when** the human agrees the step list, sequencing, decisions, and review points.

## Map

Read [`references/catalog-mapping.md`](references/catalog-mapping.md). Apply those rules to the confirmed structure. Read [`references/stage-prompt-template.md`](references/stage-prompt-template.md) for each stage's `system_prompt`, `model`, and `gate_kinds`.

**Done when** you have a pipeline id, one stage id per step, `needs` / `fork` wiring, and a prompt plan per stage.

## Locate

Read [`references/catalog-write-conventions.md`](references/catalog-write-conventions.md). Resolve the write directory and check every candidate pipeline and stage id against files already there.

**Done when** every id is free, or the human has given a different id.

## Write

Write one external stage YAML per step and one pipeline YAML that wires them with `uses: ./<id>.yaml`. Use the native Write tool. Do not call `createPipeline` or `createStage`. Do not write a `*.task.yaml`.

**Done when** the pipeline file and every stage file exist on disk.

## Validate and report

Read [`references/validate-and-report.md`](references/validate-and-report.md). Follow it to the end.

**Done when** that file's success report is printed.
