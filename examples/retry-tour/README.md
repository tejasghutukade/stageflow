# Retry tour

One short spine that walks Stageflow’s **retry surfaces**. Each stage does one job. First passes are supposed to fail; later attempts (or a second emit in the same session) pass.

This catalog is a **deep spine**: ungated `to:` is the next stop. Open the stage after each stop and inspect **attempts** — automatic repair is a second attempt on the same node, not a new stage.

Two stops need you: **Retry with guidance** on `manual-recover`, then **Retry** on `ordinary-retry`.

## Run

From the repo git root, after `sf ui` is up, pick pipeline `retry-tour` and task `retry-tour`.

Or:

```bash
npx tsx src/cli.ts validate --pipeline examples/retry-tour/retry-tour.pipeline.yaml
npx tsx src/cli.ts run \
  --pipeline examples/retry-tour/retry-tour.pipeline.yaml \
  --task examples/retry-tour/retry-tour.task.yaml
```

Validate should succeed (`ok: true`). You may see `pipeline.model_applies` because `model` is set on the pipeline, not on each stage.

The run should **succeed** after the two operator actions below. If a model writes `proof.md` on attempt 1, that stop is not covered — rerun.

## Walk (follow-along order)

| Level | Stage | Retry surface | What you do |
|-------|-------|---------------|-------------|
| 1 | `kickoff` | none | Watch it succeed |
| 2 | `emit-retry` | Emit-phase verify soft reject | Same attempt: first emit is rejected (`note.md` missing), second emit succeeds. Attempt stays **1** |
| 3 | `auto-repair` | `on_verify_fail.mode: repair` | Attempt 1 omits `proof.md` → after-verify fails → Stageflow starts attempt 2 by itself. Attempt 2 writes `proof.md`. No click |
| 4 | `manual-recover` | `on_verify_fail.mode: manual` | Attempt 1 fails after-verify. Stage stays **failed**. Select it → type guidance (for example `Write proof.md this time`) → **Retry with guidance**. Do **not** use **Retry**. Do **not** **Stop recovery** |
| 5 | `ordinary-retry` | Ordinary **Retry** (no `on_verify_fail`) | Attempt 1 emits `status: failure`. Select it → **Retry**. Attempt 2 emits success |
| 6 | `done` | none | Runs only after `ordinary-retry` succeeds — proof that Retry unblocked the successor |

## Scenario table

| Scenario | How this pipeline covers it | Evidence |
|----------|------------------------------|----------|
| Emit-phase verify rejects in-session | `emit-retry` `type: artifact` `when: [emit]` | First `emit_stage_envelope` is `isError`; second emit is accepted; still attempt 1 |
| Emit reject does not fail the stage | same | Stage succeeds; no `on_verify_fail` |
| Automatic repair after after-phase fail | `auto-repair` `mode: repair` `max_attempts: 2` | Attempt 1 verification **failed**; attempt 2 **passed**; stage succeeded with no click |
| `max_attempts: 2` means 1 initial + 1 repair | same | Exactly two attempts on `auto-repair` |
| Failed-check capsule on repair | `include_failed_checks: true` | Attempt 2 prompt contains failed-check evidence for `proof-on-disk` |
| Repair is a fresh attempt | same | Attempt 2 has its own artifacts dir |
| Manual recovery (not auto) | `manual-recover` `mode: manual` `retry_safety: side_effecting` | After attempt 1 fail, stage stays failed until Recover |
| Ordinary **Retry** is refused here | same | Map/workspace **Retry** should 409; use **Retry with guidance** |
| Recover with guidance | operator types guidance | Attempt 2 prompt includes operator instructions + failed-check capsule |
| Ordinary Retry after agent failure | `ordinary-retry` emits `status: failure` | No after-verify; **Retry** is offered |
| Retry unblocks the successor | `done` | `done` does not start while `ordinary-retry` is failed; it runs after Retry succeeds |

## Expected stage status (after the full walk)

| Stage | Attempts | Final status | Why |
|-------|----------|--------------|-----|
| `kickoff` | 1 | succeeded | entry |
| `emit-retry` | 1 | succeeded | two emits, one attempt |
| `auto-repair` | 2 | succeeded | automatic repair |
| `manual-recover` | 2 | succeeded | you Recovered |
| `ordinary-retry` | 2 | succeeded | you Retried |
| `done` | 1 | succeeded | ungated after ordinary-retry success |

Mid-walk: after `auto-repair` succeeds, `manual-recover` is **failed** and the run looks failed until Recover. Then `ordinary-retry` is **failed** until Retry.

## Not in this pipeline

| Scenario | Why it is absent | Where to see it |
|---------|------------------|-----------------|
| Repair budget exhausted | would fail the stage after attempt 2 | `max_attempts: 2` with another miss; then ordinary Retry |
| **Stop recovery** | terminal fail for that stage this run | click it on `manual-recover` instead of Recover |
| Loop `send_back` / `max_replays` | different product (route loop) | [`examples/route-if-tour/`](../route-if-tour/), [`examples/feedback-loop/`](../feedback-loop/) |
| `on_verify_fail` with emit-only verify | illegal (`pipeline.invalid_recovery`) | yaml-catalog |
| `mode: repair` + `retry_safety: side_effecting` | illegal | yaml-catalog |
| Agent never emits (timeout / hang) | flaky | ordinary Retry after a real hang |
