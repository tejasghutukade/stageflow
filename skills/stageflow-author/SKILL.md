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

Read [`references/catalog-mapping.md`](references/catalog-mapping.md). Apply those rules to the confirmed structure. Read [`references/stage-prompt-template.md`](references/stage-prompt-template.md) for each stage's `system_prompt`, optional `model`, `io`, `verify`, and `gate_kinds`. Apply the Anti-patterns section below while mapping. When the human needs hard advance gates, plan body `verify` and wiring `on_verify_fail`. When a review can demand changes, include an address-feedback stage before approve/ship.

**Done when** you have a pipeline id, one stage id per step, `route` / `entry` wiring (optional `if`, `{ type: loop }`), a prompt plan per stage, and any `verify` / `on_verify_fail` / remediation stages the structure requires.

## Anti-patterns

Author these contracts explicitly. They come from long runs that failed after hours of real work.

| Always do | How |
|---|---|
| End every attempt on a tool call | Prompt: last call is `emit_stage_envelope`, or `ask_operator` while waiting on HITL. Each clonable instance emits on its own. |
| Land required files in the attempt artifact dir | Prompt `write_stage_artifact`. Body `verify` with `type: artifact` and `when` including `after`. `ask_operator` `artifact_backed` references that same path. |
| Make implement stages change the checkout | Body `verify` `checkout_changes` + `path_fields`; `io.output.schema` with required checkout-relative path arrays. Exploration-only is its own stage or a failure emit. |
| Hand successors clean envelopes | `summary` / `payload` = outcomes and artifact pointers only. Name required `io.output.schema` fields in the prompt. |
| Give review blockers a place to land | Wire `review → address-feedback → approve/ship`. Put `verdict` / `blocking_findings` (or equivalent) in the review `io.output.schema`. |
| Bind success to the full checklist | If a plan lists N commands, success requires all of them in `commands_run` with exit 0. Cheap checks first; slow suites last or in a verify stage. Size `timeout_ms` to the work. |
| Use configured models on every sibling | Same configured `model` family after fan-out unless the human asks otherwise. Reliable model on publish/PR stages. |
| Finish publish in the accept attempt | After `artifact_backed` accept: side effects (commit/push/PR) → final artifact → emit in the same attempt. Fix emit/schema errors by re-emitting. |
| Emit full clone assignments | When `clonable: true`, parent success uses `clone_forks` with full envelopes matching `io.input.schema`. Leave clonable unset when the clone count is unknown. |

Throwaway checkout deliverables (HTML spike, scratch file): prompt builtin `write` at a checkout-relative path, `artifacts: []` on emit, path in `payload`.

## Locate

Read [`references/catalog-write-conventions.md`](references/catalog-write-conventions.md). Resolve the write directory and check every candidate pipeline and stage id against files already there.

**Done when** every id is free, or the human has given a different id.

## Write

Write one external stage YAML per step and one pipeline YAML that wires them with `uses: ./<id>.yaml`. Use the native Write tool. Do not call `createPipeline` or `createStage`. Do not write a `*.task.yaml`.

**Done when** the pipeline file and every stage file exist on disk.

## Validate and report

Read [`references/validate-and-report.md`](references/validate-and-report.md). Follow it to the end.

**Done when** that file's success report is printed.
