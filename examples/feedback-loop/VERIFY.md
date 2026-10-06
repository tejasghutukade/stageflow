# Feedback-loop manual verification

Simple runs to exercise the feedback-loop work from this repo. Uses a real provider (not FakeAgent).

## Setup

```bash
cd /path/to/software-factory
npm i
npm run build
# Provider auth once (example stages use omniroute/auto)
# Connect via: npm run dev -- ui  → Settings → Providers
```

Use `npm run dev -- …` as `sf` from this worktree. Run state lives in `<repo>/.stageflow/`.

Optional console:

```bash
npm run dev -- ui
```

If `sf ui` is up on `:3847`, mutating CLI (`runs feedback-decide`) is refused — decide in the UI panel, or stop the host and use CLI.

Validate once:

```bash
npm run dev -- validate --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml --strict
npm run dev -- validate --pipeline examples/feedback-loop/feedback-loop-wait-human.pipeline.yaml --strict
```

---

## Scenario A — Continue only (happy path)

**Expect:** `plan → implement → review → submit`, no replay.

```bash
npm run dev -- run \
  --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml \
  --task examples/feedback-loop/continue-only.task.yaml \
  --json > /tmp/fb-a.json
```

**Pass:** exit `0`; all four stages `succeeded`; `submit` ran once.

```bash
RUN=$(jq -r .runId /tmp/fb-a.json)
npm run dev -- runs show --run "$RUN" --json | jq '{
  status,
  stages: [.stages[] | {id: .stage_id, status}],
  active: .active_feedback_loop,
  loops: [.feedback_loops[]?.loop.state]
}'
```

**Fail:** any `send_back`, or `submit` never runs.

---

## Scenario B — One send_back, then continue

**Expect:** review sends back to `implement` once; replay includes Feedback Loop Context; then continue → submit.

```bash
npm run dev -- run \
  --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml \
  --task examples/feedback-loop/send-back-once.task.yaml \
  --json > /tmp/fb-b.json
```

**Pass:**

- Stage path roughly `plan → implement → review → implement → review → submit`
- One replay in history; loop ends `continued`
- On the replayed stages, the agent prompt shows a **Feedback Loop Context** block

```bash
RUN=$(jq -r .runId /tmp/fb-b.json)
npm run dev -- runs show --run "$RUN" --json | jq '{
  status,
  stages: [.stages[] | {id: .stage_id, status}],
  replays: [.feedback_loops[0].replays[] | {
    n: .replay.replay_number,
    target: .replay.target_stage_id,
    status: .replay.status
  }],
  loop: .feedback_loops[0].loop.state
}'
```

UI: Feedback Loop panel shows budget / route / replay timeline.

**Fail:** submit before continue; no replay recorded; no Feedback Loop Context on replay.

---

## Scenario C — Exhaust `require_continue` (over-limit send_back fails)

Pipeline: `max_replays: 2`, `on_max_replays: require_continue`.

**Expect:** two accepted send_backs, third rejected; `submit` never succeeds.

```bash
npm run dev -- run \
  --pipeline examples/feedback-loop/feedback-loop.pipeline.yaml \
  --task examples/feedback-loop/exhaust-require-continue.task.yaml \
  --json > /tmp/fb-c.json
```

**Pass:** run failed; ~2 replays; failure mentions `max_replays` / `require_continue`; `submit` not succeeded.

```bash
RUN=$(jq -r .runId /tmp/fb-c.json)
npm run dev -- runs show --run "$RUN" --json | jq '{
  status,
  failed_stage_id,
  failed_reason,
  replay_count: (.feedback_loops[0].replays | length),
  submit: [.stages[] | select(.stage_id=="submit") | .status]
}'
```

**Fail:** third send_back accepted; run succeeds; or parks for human (wrong policy).

---

## Scenario D — Exhaust `wait_for_human`, then decide

Pipeline: `feedback-loop-wait-human.pipeline.yaml` (`max_replays: 1`, `on_max_replays: wait_for_human`).

**Pairing:** You **must** use `feedback-loop-wait-human.pipeline.yaml` with `exhaust-wait-human.task.yaml`. The default `feedback-loop.pipeline.yaml` uses `require_continue` — wrong pipeline means **no human ask** (run fails on over-limit send_back instead of parking). Every review success until park must `send_back` (never `continue`).

**Expect:** second send_back parks the run; you choose extend / continue / abandon.

Prefer **no** `sf ui` on `:3847` if you will use CLI decide.

```bash
npm run dev -- run \
  --pipeline examples/feedback-loop/feedback-loop-wait-human.pipeline.yaml \
  --task examples/feedback-loop/exhaust-wait-human.task.yaml \
  --json > /tmp/fb-d.json
# Exit 2 when parked waiting is normal
```

Inspect the park:

```bash
RUN=$(jq -r .runId /tmp/fb-d.json)
npm run dev -- runs waiting --run "$RUN" --json
npm run dev -- runs show --run "$RUN" --json | jq '.active_feedback_loop | {
  state, policy, deferred_send_back
}'
```

Expect `waiting_kind: "feedback_loop_decision"`, `state: "waiting_for_human"`, deferred target `implement`.

Pick **one** decision (host down for CLI):

```bash
# Extra replay budget, then agent should continue later
npm run dev -- runs feedback-decide --run "$RUN" --stage review --decision extend --json

# Or release downstream without another replay
npm run dev -- runs feedback-decide --run "$RUN" --stage review --decision continue --json

# Or fail the run
npm run dev -- runs feedback-decide --run "$RUN" --stage review --decision abandon --reason "stop" --json
```

With `sf ui` instead: open the run → FeedbackDecidePanel → Extend / Continue / Abandon.

After decide, wait for terminal if needed:

```bash
npm run dev -- runs wait --run "$RUN" --until terminal --timeout-ms 240000 --json
```

**Pass:**

| Decision | Expect |
|----------|--------|
| `extend` | `effect: extended`; another implement→review; then continue → submit; `max_replays` bumped by 1 |
| `continue` | `effect: continued`; submit runs; no further replay |
| `abandon` | run `failed`; submit never runs |

**Fail:** second send_back rejected instead of parking; decide refused while host is still up.

---

## Quick matrix

| Scenario | Pipeline | Task | Cost note |
|----------|----------|------|-----------|
| A Continue | `feedback-loop.pipeline.yaml` | `continue-only.task.yaml` | ~4 stages |
| B One send_back | `feedback-loop.pipeline.yaml` | `send-back-once.task.yaml` | ~6 stage runs |
| C require_continue exhaust | `feedback-loop.pipeline.yaml` | `exhaust-require-continue.task.yaml` | ~7+ stage runs, expects failure |
| D wait_for_human | `feedback-loop-wait-human.pipeline.yaml` | `exhaust-wait-human.task.yaml` | parks; then decide |

Clone-chain Loop from Join is covered by fixture
[`tests/fixtures/pipelines/clone-chain-loop-from-join.pipeline.yaml`](../../tests/fixtures/pipelines/clone-chain-loop-from-join.pipeline.yaml),
not this walkthrough.

## References

- [YAML catalog — Feedback loops](../../docs/yaml-catalog.md#feedback-loops)
- [CLI — feedback-decide](../../docs/cli-reference.md#sf-runs-feedback-decide)
- [Envelopes — Feedback loops](../../docs/envelopes.md#feedback-loops)
