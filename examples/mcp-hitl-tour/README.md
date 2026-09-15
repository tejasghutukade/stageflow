# mcp-hitl-tour

MCP-first walkthrough: **HITL**, an ungated **fan-out/join**, a small **Clone
Chain**, a **guaranteed feedback loop** that parks for `decide_feedback_loop`,
and **artifacts** you can read back with `read_artifact`.

Domain-neutral — it writes a short brief. Use it to see how an operator-host
MCP client starts a run, asks the operator at each HITL gate, inspects a
stage, and decides the loop.

This DAG does **not** exclusive-route. Exclusive Route `if` into a shared join
can leave the unused arm `pending`, so the join never becomes runnable. Here
both arms always run; `polish` waits for two successes, not a skip.

```
start_run → wait_run → answer_gate (intake) → wait_run
         → review send_back → polish replay → review send_back
         → decide_feedback_loop → wait_run until terminal
         → get_run / list_stage_events / get_envelope / read_artifact
```

## What it exercises

| Stage | Why it is here |
|-------|----------------|
| `intake` | `gate_kinds: [free_text]` — MCP `answer_gate`. Emits `payload.audience`. Writes `intake.md`. |
| Fan-out | Intake lists `emit-angles` and `draft-short` with **no** `if`. Both always run. |
| `emit-angles` → `draft-angle` → `gather` | Sequential Clone Chain, `clone_cap: 2`. Clone workers write `angle.md`. |
| `draft-short` | Parallel short take. Writes `short.md`. |
| `polish` | Join of `gather` and `draft-short`. Writes `brief.md`. Loop target. |
| `review` | Always `send_back` polish. `{ type: loop }`, `max_replays: 1`, `on_max_replays: wait_for_human` — one replay, then operator HITL. |
| `ship` | `replay_safe: false`. Writes `ship.md`. |

`describe_pipeline` should show `entry`, clone fields, `feedback_loop`,
`gate_kinds` on intake, and `replay_safe` on ship. It should **not** show
inbound `if` on the intake children.

```
intake (free_text HITL)
  ├─ emit-angles → draft-angle×2 → gather ─┐
  └─ draft-short ──────────────────────────┴→ polish ► review ⇄ polish ► ship
```

## Prerequisites

- This **feat/mcp-console-parity** tree, built (`npm run build && npm run ui:build`)
- Provider auth connected
- An MCP client (Cursor on **another** project is fine) pointed at `http://127.0.0.1:3847/mcp`

Host the catalog from **this git root** so `list_pipelines` includes this example:

```bash
cd /path/to/feat-mcp-console-parity
node dist/cli.js ui
```

## MCP walkthrough

From a consumer Cursor chat with Stageflow MCP loaded:

1. `describe_pipeline` `{ "pipeline": "examples/mcp-hitl-tour/mcp-hitl-tour.pipeline.yaml" }`
2. `start_run` with
   - `pipeline`: `examples/mcp-hitl-tour/mcp-hitl-tour.pipeline.yaml`
   - `task_path`: `examples/mcp-hitl-tour/mcp-hitl-tour.task.yaml`
3. `wait_run` `{ "runId": "…", "until": "waiting" }`
4. Present the intake prompt to the operator. `answer_gate` — `stageId` is
   `intake`, `kind` is `free_text`, `text` is `operators` or `executives`,
   `promptId` from the pending prompt. Do not invent the reply.
5. `wait_run` `{ "runId": "…", "until": "waiting" }` — review sends the brief
   back once (polish replays), then parks (`waiting_kind` is
   `feedback_loop_decision`)
6. Present the loop decision to the operator. `decide_feedback_loop` with
   `decision: "continue"` (or `extend` / `abandon`)
7. `wait_run` `{ "runId": "…", "until": "terminal" }`
8. `get_run` — artifact paths, `total_cost_usd` when the store has it
9. `read_artifact` `intake.md` / `short.md` / `angles-brief.md` / `brief.md` /
   `ship.md` (use the paths `get_run` returned)
10. `list_stage_events` `{ "runId": "…", "stageId": "intake" }`
11. `get_envelope` `{ "runId": "…", "stageId": "intake" }` — `payload.audience`
    matches the gate reply

The exhaust task (`mcp-hitl-tour-exhaust.task.yaml`) is the same walkthrough.

## Validate

```bash
node dist/cli.js validate --pipeline examples/mcp-hitl-tour/mcp-hitl-tour.pipeline.yaml --strict
```

## Layout

```
examples/mcp-hitl-tour/
  mcp-hitl-tour.pipeline.yaml
  mcp-hitl-tour.task.yaml
  mcp-hitl-tour-exhaust.task.yaml
  intake.yaml
  emit-angles.yaml
  draft-angle.yaml
  gather.yaml
  draft-short.yaml
  polish.yaml
  review.yaml
  ship.yaml
```

## References

- [MCP](../../docs/mcp.md)
- [HITL](../../docs/hitl.md)
- [YAML catalog — Generic fan-in](../../docs/yaml-catalog.md#generic-fan-in)
- [YAML catalog — Clone Chain](../../docs/yaml-catalog.md#clone-chain)
- [YAML catalog — Feedback loops](../../docs/yaml-catalog.md#feedback-loops)
