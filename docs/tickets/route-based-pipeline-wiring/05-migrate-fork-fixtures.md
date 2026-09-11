# 05: Migrate fork fixtures and tests to route

**What to build:** The fork-context test file and its fixtures — single-choice forks, subset forks, `allow_none` cases, parallel/multi-branch pipelines — are rewritten to use `route` with `route_select`/`allow_none` (from ticket 02) instead of `fork`. Any of these fixtures that also use `needs` for their branch stages' wiring are migrated to `route`/`entry` as part of this ticket too (so this batch's fixtures end up fully on the new syntax, not half-migrated). `fork` itself is not removed from the schema yet (that's ticket 07); this ticket only stops relying on it in this test file's fixtures.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] Every fixture and test case in the fork-context test file now uses `route`/`route_select`/`allow_none`/`entry` instead of `needs`/`fork`, and the suite is green.
- [ ] Single-choice (`select: "one"`) and subset (`select: "subset"`) fork fixtures, plus both `allow_none` values, all have route-based equivalents that assert the same selection/skip-cascade behavior as before.
- [ ] Any parallel/multi-branch fixture shared with the general DAG or feedback-loop test files is coordinated with tickets 04/06 so it isn't migrated twice with diverging results.
- [ ] No fixture or test in this batch references `needs` or `fork` by the end of this ticket.
- [ ] `feedback_loop` support elsewhere in the codebase is untouched.
