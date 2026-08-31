---
layout: default
title: Hitl
---

# Human-in-the-loop (HITL)

Stages can pause for **operator input** via the `ask_operator` Pi tool. The operator console (or a resumed worker) supplies answers; the stage continues until it calls `emit_stage_envelope`.

HITL is optional — pipelines with no `ask_operator` calls run fully headless.

## Gate kinds

Declared in stage YAML as `gate_kinds` (optional but recommended for documentation and validation):

| Kind | Purpose |
|------|---------|
| `free_text` | Open-ended operator reply |
| `confirm` | Yes/no (or accept/reject) confirmation |
| `multi_question` | Batch of sub-questions (each sub-question has its own kind) |
| `artifact_backed` | Operator reviews one or more artifact paths before accepting |

Allowed values are fixed in `STAGE_GATE_KINDS` (`src/types/stage.ts`).

Canonical exercise stage: [`tests/fixtures/stages/hitl-four-kinds.yaml`](../tests/fixtures/stages/hitl-four-kinds.yaml) — walks all four kinds in order.

Plan review with artifact gate: [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

## Operator flow

1. Stage agent calls `ask_operator` with a `kind` and message (and `artifacts` for `artifact_backed`)
2. Run enters **waiting** state
3. Operator replies in the console (run detail stream) or via runtime resume
4. Stage agent continues; may call `ask_operator` again or finish with `emit_stage_envelope`

`ask_operator` **does not** complete the stage — only `emit_stage_envelope` does.

## CLI behavior

### Default: park on wait

```bash
sf run --task tests/fixtures/tasks/sample.task.yaml --pipeline tests/fixtures/pipelines/plan-review-proving.pipeline.yaml
```

When a stage waits, the CLI exits **`2`** and prints the run folder path. The run stays resumable from the console.

JSON with `--json`:

```json
{
  "ok": false,
  "outcome": "waiting",
  "runId": "…",
  "runDir": "…"
}
```

### `--skip-gates`

```bash
sf run --task tests/fixtures/tasks/sample.task.yaml --pipeline tests/fixtures/pipelines/plan-review-proving.pipeline.yaml --skip-gates
```

If a stage would wait, the worker **fails immediately** with reason `skip-gates: stage requested wait`. Exit code **`1`**, not `2`.

Use in CI when HITL must not block the job — but the run will not get operator answers. Pipelines with **no** HITL never need this flag.

On a mixed pipeline (some stages with gates, some without), default behavior parks the whole run at the first gate; `--skip-gates` fails at that gate instead.

## Exit codes (summary)

| Code | CLI `sf run` | Stage worker |
|------|--------------|--------------|
| `0` | Succeeded | Stage succeeded |
| `1` | Failed / busy / skip-gates | Stage failed |
| `2` | Waiting on operator | Stage waiting |

`sf validate` never exits `2`.

## Declaring gates in YAML

```yaml
id: plan-review
gate_kinds:
  - artifact_backed
system_prompt: |
  Write plan.md, ask_operator artifact_backed, emit on accept.
model: anthropic/claude-sonnet-4-5
```

`gate_kinds` documents intent; runtime enforcement is via actual `ask_operator` calls in the agent session.

## Console reply

Open `sf ui`, go to **Today** (waiting count badge) or **Runs**, open the run, and use the gate reply surface in the run detail stream.

Answers go to the **selected** stage instance id. Today shows the first waiter (`waiting_stage_id`) even when several clones wait — the same as dual named-sibling wait. Open the run and select the other clone to answer it. Waiting-card copy keeps the raw `waiting_stage_id`.

See [Operator console — Clone tracks](operator-console.md#clone-tracks).

## MCP

Use `list_waiting` / `answer_gate` and `wait_run` over the `/mcp` endpoint while `sf ui` runs — see [MCP](mcp.md#wait_run) for the compose loop (`wait_run` → `answer_gate` → `wait_run`). Operator replies remain available in the console.

## See also

- [Envelopes](envelopes.md) — completing a stage after gates
- [CI / headless](ci.md) — `--skip-gates` in automation
- [YAML catalog](yaml-catalog.md) — `gate_kinds` field
- [`tests/fixtures/pipelines/hitl-four-kinds-proving.pipeline.yaml`](../tests/fixtures/pipelines/hitl-four-kinds-proving.pipeline.yaml)
