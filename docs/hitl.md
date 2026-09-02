---
layout: default
title: Hitl
---

# Human-in-the-loop (HITL)

Stages can pause for **operator input** via the `ask_operator` Pi tool. The operator console (or a resumed worker) supplies answers; the stage continues until it calls `emit_stage_envelope`.

HITL is optional — pipelines with no `ask_operator` calls run fully headless.

## Gate kinds

Declared in stage YAML as `gate_kinds` (optional but recommended):

| Kind | Purpose |
|------|---------|
| `free_text` | Open-ended operator reply |
| `confirm` | Accept/reject confirmation (yes/no is a UI label only) |
| `multi_question` | Batch of sub-questions (each sub-question has its own kind) |
| `artifact_backed` | Operator reviews one or more artifact paths before accepting |

Allowed values are the catalog enum `STAGE_GATE_KINDS` (`src/types/stage.ts`). `gate_kinds` documents intent and catalog membership. Runtime does **not** require each `ask_operator` kind to be a subset of the declared list.

Canonical `confirm` answers use `decision: "accept" | "reject"`.

Canonical exercise stage: [`tests/fixtures/stages/hitl-four-kinds.yaml`](../tests/fixtures/stages/hitl-four-kinds.yaml) — walks all four kinds in order.

Plan review with artifact gate: [`tests/fixtures/stages/plan-review.yaml`](../tests/fixtures/stages/plan-review.yaml).

## `ask_operator` contract

Params and answers (`src/tools/askOperator.ts`). Optional `id` on the prompt becomes `promptId` on the answer.

| Kind | Params | Answer |
|------|--------|--------|
| `free_text` | `message`, optional `id` | `{ kind, promptId, text }` |
| `confirm` | `message`, optional `id` | `{ kind, promptId, decision: "accept" \| "reject", text? }` |
| `artifact_backed` | `message`, non-empty `artifacts[]`, optional `id` | `{ kind, promptId, decision: "accept" \| "reject", text? }` |
| `multi_question` | `questions[]` of `free_text` or `confirm` only (nested `multi_question` / `artifact_backed` rejected) | `{ kind, promptId, answers }` — one entry per sub-question |

## Operator flow

1. Stage agent calls `ask_operator` with a `kind` and message (and `artifacts` for `artifact_backed`)
2. Run enters **waiting** state
3. Operator replies in the console (select the stage on the spatial map — or open `#/runs/<runId>/stages/<stageId>` — and use the workspace reply surface), via MCP `answer_gate` while `sf ui` or `sf mcp` is running, or via `sf runs answer` when the host is down. Waiting cards on Today can also accept eligible gates.
4. Stage agent continues; may call `ask_operator` again or finish with `emit_stage_envelope`

`ask_operator` **does not** complete the stage — only `emit_stage_envelope` does.

## CLI behavior

### Default: park on wait

```bash
sf run --task tests/fixtures/tasks/sample.task.yaml --pipeline tests/fixtures/pipelines/plan-review-proving.pipeline.yaml
```

When a stage waits, the CLI exits **`2`** and prints the run folder path. Continue with `sf runs waiting` / `answer` / `wait` (host down), or from the console / MCP while a host is up. See [CLI reference — `sf runs`](cli-reference.md#sf-runs).

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

`--skip-gates` fires when the stage **enters wait** via `ask_operator`, not merely because `gate_kinds` is declared. The worker **fails immediately** with reason `skip-gates: stage requested wait`. Exit code **`1`**, not `2`.

Use in CI when HITL must not block the job — but the run will not get operator answers. Pipelines with **no** HITL never need this flag.

On a mixed pipeline (some stages with gates, some without), default behavior parks the whole run at the first `ask_operator` wait; `--skip-gates` fails at that wait instead.

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

`gate_kinds` documents intent and catalog enum membership; runtime enforcement is via actual `ask_operator` calls in the agent session.

## Console reply

Open `sf ui`, go to **Today** (waiting count badge) or **Runs**, open the run, and select the waiting stage on the spatial map — or open `#/runs/<runId>/stages/<stageId>`. The reply surface lives in that gated workspace. Eligible waiting cards on Today can also Accept. See [Operator console](operator-console.md).

Answers go to the **selected** stage instance id. Today shows the first waiter (`waiting_stage_id`) even when several clones wait — the same as dual named-sibling wait. Open the run and select the other clone to answer it. Waiting-card copy keeps the raw `waiting_stage_id`.

See [Operator console — Clone tracks](operator-console.md#clone-tracks).

## MCP

Use `list_waiting` / `answer_gate` and `wait_run` over the `/mcp` endpoint while `sf ui` or `sf mcp` is running — see [MCP](mcp.md#wait_run) for the compose loop (`wait_run` → `answer_gate` → `wait_run`). Operator replies remain available in the console. Console and MCP stay valid when a host is up; mutating `sf runs` verbs refuse in that case.

When no host is up, the same loop is `sf runs waiting` / `answer` / `wait`. After `sf run` exit `2`, list waiting gates, answer, then wait — do not treat `answer` `{ "ok": true }` as terminal. See [CLI reference — `sf runs`](cli-reference.md#sf-runs).

When a coding-agent host is driving the run (the `stageflow-run` skill), a mappable gate is presented on that host's native question UI when one exists, then submitted with `answer_gate` (host up) or `sf runs answer --json` (host down). Open-ended `free_text` and hosts without a picker stay in chat. A representable `multi_question` is one picker call, not sequential cards. See [`skills/stageflow-run/references/native-question-ui.md`](../skills/stageflow-run/references/native-question-ui.md).

## See also

- [Envelopes](envelopes.md) — completing a stage after gates
- [CI / headless](ci.md) — `--skip-gates` in automation
- [YAML catalog](yaml-catalog.md) — `gate_kinds` field
- [`tests/fixtures/pipelines/hitl-four-kinds-proving.pipeline.yaml`](../tests/fixtures/pipelines/hitl-four-kinds-proving.pipeline.yaml)
