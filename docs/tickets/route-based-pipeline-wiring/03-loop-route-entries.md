# 03: Loop route entries

**What to build:** A stage can declare a `type: loop` entry inside its `route` list, sending execution back to an earlier stage instead of continuing forward: `{type: loop, to: <ancestor>, max_replays, on_max_replays, replay_session}`, carrying the same retry-policy fields and meaning as today's `feedback_loop`. A loop entry contributes no forward DAG edge (it's a runtime-only replay schedule over the already-resolved forward graph from ticket 01) and is therefore excluded from cycle detection. Validation carries over unchanged: `to` must resolve to a declared ancestor of the source stage; neither source nor target may be `clonable`; no stage on the resulting replay route (target through source, inclusive) may have `replay_safe: false`. This ticket builds on ticket 01's forward-routing resolution; it does not touch `needs`, `fork`, or `feedback_loop`, which keep working unchanged. Proven with new fixtures only.

**Blocked by:** 01 (needs the forward graph to compute ancestry)

**Status:** ready-for-agent

- [ ] A stage can declare a `{type: loop, to: <ancestor>}` route entry that triggers a replay back to that ancestor, with the same runtime semantics as today's `feedback_loop`.
- [ ] `max_replays`, `on_max_replays` (`require_continue` / `wait_for_human`), and `replay_session` (`resume` / `new_session`) behave identically to their `feedback_loop` counterparts today.
- [ ] A loop entry whose `to` is not a declared ancestor of the source stage fails validation.
- [ ] A loop entry where the source or target stage is `clonable` fails validation.
- [ ] A loop entry where any stage on the replay route (target through source, inclusive) has `replay_safe: false` fails validation.
- [ ] Loop entries are excluded from forward-cycle detection — a pipeline with a legitimate loop entry does not trip the cycle check from ticket 01.
- [ ] A stage's `route` can mix a forward entry and a loop entry together (e.g. continue vs. send-back), both resolved from the same list.
- [ ] `needs`, `fork`, and `feedback_loop` continue to parse and resolve exactly as before; no existing test or fixture using them is touched or broken.
- [ ] New fixtures and resolver tests cover: a basic loop, each `on_max_replays` value, each `replay_session` value, non-ancestor rejection, `clonable` rejection, and `replay_safe: false` rejection.
