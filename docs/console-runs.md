---
layout: default
title: Console - Pipeline runs
---

# Pipeline runs

## Run list (`#/runs`)

Filter chips: **All**, **Needs you**, **Running**, **Failed**, **Succeeded**. Each row stacks the run's identity (pipeline and task) above a full-width mini track of its stages. **J / K** move, **Enter** opens, **R** retries a failed stage, **A** answers the waiting gate.

## Start a run

`#/new`, the rail's **Start a run** button, **S** on a pipeline or task, or the palette. The dialog picks a **Task** (searchable by id or goal), a **Pipeline**, and optionally a model override and checkout branch. It shows whether the provider is connected and whether the pipeline is valid before you start. Query params `?pipeline=` and `?task=` preselect.

## Run detail (`#/runs/<runId>`)

The header shows the run id (copy with **C**), status, pipeline, task and duration. A created run shows **not started**; the primary action is **Start run** until history exists, after that **Start fresh** (**F**, a new run with the same pipeline and task). **More run actions** has **Cancel run** (stops every active stage and marks the run cancelled; history is kept) and **Delete run**.

### Stage views

A toggle switches how the stages are drawn:

| View | Shows |
|------|-------|
| **Timeline** | Stages on a time axis (Gantt) |
| **Graph** | The stage graph, with wires between stages |
| **List** | One row per stage |

Select a stage to open its workspace. The center of the workspace has four tabs:

| Tab | Shows |
|-----|-------|
| **Transcript** | Conversation: system dividers, prompt, thinking, assistant text and tool calls |
| **Events** | The raw event stream, filterable by kind (tool, message, operator_prompt, ...) |
| **Envelope** | The handoff envelope: `summary`, `payload`, artifact paths, without reading logs |
| **Artifacts** | Files the stage produced |

`#/runs/<runId>/stages/<stageId>` selects that stage; `.../envelope` opens the envelope; `#/runs/<runId>/artifacts?path=…` opens one artifact. When a stage has an envelope the first Files row is **Handoff envelope**.

### Stage actions

- A failed stage offers **Retry stage** (**R**). When a failed after-phase `verify` has `on_verify_fail.mode: manual`, the stage instead shows its verification history and offers **Retry with guidance** or **Stop recovery**.
- A running stage offers **Abandon** (stops the stage, marks it failed, leaves the rest of the run alone).
- An interrupted stage offers **Resume** (continues the attempt on the same agent session).
- A stage waiting on a gate shows the answer panel ("<stage> is asking you"): **Accept** (**1**), **Reject** (**3**), note (**N**). It is the same panel as in the [Inbox](console-inbox.md#answering-a-pipeline-gate).

### Diamond fan-in {#diamond-fan-in}

A [generic fan-in](yaml-catalog.md#generic-fan-in) join renders as a diamond: two (or more) incoming wires into the join node. While the join is blocked, `blocked_by` lists every unresolved parent, not only the first. After one parent reaches an accepted terminal, that parent drops off `blocked_by` and the remaining wires stay.

Walkthrough: [`examples/generic-fan-in/`](../examples/generic-fan-in/). Fixture: [`diamond-fan-in.pipeline.yaml`](../tests/fixtures/pipelines/diamond-fan-in.pipeline.yaml).

## Capacity

The rail footer can show active run count against the soft maximum (the same data as MCP `get_health`). Change the limit in [Settings → Concurrency](console-settings.md#concurrency).
