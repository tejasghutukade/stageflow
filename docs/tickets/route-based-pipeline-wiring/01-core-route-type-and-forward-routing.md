# 01: Core route type and forward-routing resolution

**What to build:** A pipeline author can declare a stage's `route` — a list of structured entries, each naming a target stage and an optional terminal-state gate (`on`) — instead of using `needs`. The DAG resolution function inverts these outbound entries into the same internal forward-edge structure the scheduler already consumes, so a stage's readiness is derived from the entries pointing at it. Pipeline authors can also mark one or more stages `entry: true` to declare where a pipeline run starts. Validation catches: an unknown route target, a cycle in forward routing, no stage marked `entry: true` anywhere in the pipeline, and a stage that is neither `entry: true` nor named by any route entry (unreachable). This ticket does not touch `needs`, `fork`, or `feedback_loop` — those keep working exactly as they do today; `route` and `entry` are additive, proven with new fixtures only.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A stage can declare `route: [{to: <stage>}]` and the target stage becomes reachable/schedulable from it, without that target declaring `needs`.
- [ ] A route entry's `on` gate is evaluated against the *declaring* stage's own terminal state (defaults to succeeded-only when omitted).
- [ ] At least one stage marked `entry: true` is required; a pipeline with none fails validation with a clear error.
- [ ] A stage that is neither `entry: true` nor the target of any route entry fails validation as unreachable.
- [ ] A route entry naming an unknown stage id fails validation with a clear error.
- [ ] A cycle formed purely from forward (non-loop) route entries is still detected and rejected.
- [ ] A stage with multiple entries in its `route` list, each with a distinct target, resolves all of them as forward edges (multi-target fan-out, no selection logic yet — that's ticket 02).
- [ ] `needs`, `fork`, and `feedback_loop` continue to parse and resolve exactly as before; no existing test or fixture using them is touched or broken.
- [ ] New fixtures and resolver tests cover: a linear `route` chain, an explicit multi-entry `entry` declaration, unknown-target rejection, missing-entry-stage rejection, unreachable-stage rejection, and forward-cycle rejection.
