# 06: Migrate feedback-loop fixtures and tests to route

**What to build:** The feedback-loop test file and its fixtures — including combinations with `clonable`/`replay_safe` and clone-fanout-retry scenarios — are rewritten to use `route` with `type: loop` entries (from ticket 03) instead of `feedback_loop`. Any of these fixtures that also use `needs` or `fork` for their surrounding wiring are migrated to `route`/`route_select`/`entry` as part of this ticket too (so this batch's fixtures end up fully on the new syntax, not half-migrated). `feedback_loop` itself is not removed from the schema yet (that's ticket 07); this ticket only stops relying on it in this test file's fixtures.

**Blocked by:** 01, 03

**Status:** ready-for-agent

- [ ] Every fixture and test case in the feedback-loop test file now uses `route` with `type: loop` entries (plus `route`/`route_select`/`entry` for any surrounding wiring) instead of `needs`/`fork`/`feedback_loop`, and the suite is green.
- [ ] Each `on_max_replays` value and each `replay_session` value has a route-based fixture exercising it, matching prior coverage.
- [ ] Clone-fanout-retry and other combined scenarios (loop plus `clonable`/`replay_safe` constraints) are migrated and still assert the same validation outcomes as before.
- [ ] No fixture or test in this batch references `needs`, `fork`, or `feedback_loop` by the end of this ticket.
